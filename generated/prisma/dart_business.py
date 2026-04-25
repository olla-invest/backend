# -*- coding: utf-8 -*-
import sys
import os
import requests
import json
import time
import zipfile
import io
import xml.etree.ElementTree as ET
from pathlib import Path
import anthropic
import psycopg2

# Windows 콘솔 UTF-8 출력 설정
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# ────────────────────────────────────────────
# 설정
# ────────────────────────────────────────────
DART_API_KEY = os.getenv("DART_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
DB_URL = os.getenv("DATABASE_URL", "")
BASE_URL = "https://opendart.fss.or.kr/api"


# ────────────────────────────────────────────
# 1. 전체 기업코드 다운로드 & 파싱
# ────────────────────────────────────────────
def get_db_stock_codes(conn) -> set:
    """DB companies 테이블에서 현재 등록된 stock_code 목록 조회"""
    with conn.cursor() as cur:
        cur.execute("SELECT stock_code FROM companies WHERE deleted_at IS NULL")
        rows = cur.fetchall()
    return {row[0] for row in rows}


def get_corp_list(db_stock_codes: set):
    """DART 전체 기업코드 ZIP 다운로드 후 DB에 있는 종목만 필터링"""
    url = f"{BASE_URL}/corpCode.xml"
    resp = requests.get(url, params={"crtfc_key": DART_API_KEY})
    resp.raise_for_status()

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        xml_data = zf.read("CORPCODE.xml")

    root = ET.fromstring(xml_data)
    corps = []
    for item in root.findall("list"):
        stock_code = item.findtext("stock_code", "").strip()
        if stock_code and stock_code in db_stock_codes:
            corps.append({
                "corp_code": item.findtext("corp_code", "").strip(),
                "corp_name": item.findtext("corp_name", "").strip(),
                "stock_code": stock_code,
            })

    print(f"[INFO] DB 종목 {len(db_stock_codes)}개 중 DART 매칭 {len(corps)}개")
    return corps


# ────────────────────────────────────────────
# 2. DART company.json으로 기업 기본정보 조회
#    (업종명 + 주요제품 포함 — 실제 동작하는 엔드포인트)
# ────────────────────────────────────────────
def get_company_info(corp_code: str) -> dict | None:
    """DART company.json에서 업종명, 주요제품, 시장구분 조회
    corp_cls: Y=코스피, K=코스닥, N=코넥스, E=기타
    """
    url = f"{BASE_URL}/company.json"
    params = {"crtfc_key": DART_API_KEY, "corp_code": corp_code}
    resp = requests.get(url, params=params)
    data = resp.json()

    if data.get("status") != "000":
        return None

    return {
        "induty_code": data.get("induty_code", "") or "",  # 업종코드 (숫자)
        "products": data.get("prd_nm", "") or "",           # 주요제품 (없을 수 있음)
        "hm_url": data.get("hm_url", "") or "",
    }


# ────────────────────────────────────────────
# 3. Claude Haiku로 주요사업 3개 추출
# ────────────────────────────────────────────
def extract_businesses_with_ai(
    client: anthropic.Anthropic,
    corp_name: str,
    induty_code: str,
    products: str,
) -> list[str] | None:
    """Claude Haiku-4.5로 핵심 주요사업 3개 추출 → 문자열 배열 반환
    prd_nm이 없어도 기업명만으로 추론 가능
    """
    info_parts = []
    if induty_code:
        info_parts.append(f"업종코드(KSIC): {induty_code}")
    if products:
        info_parts.append(f"주요제품/서비스: {products}")
    info_text = "\n".join(info_parts) if info_parts else "(정보 없음, 기업명으로 추론)"

    prompt = f"""한국 상장기업의 핵심 주요사업을 정확히 3개만 추출하세요.

기업명: {corp_name}
{info_text}

규칙:
- 반드시 JSON 배열 형태로만 응답 (다른 텍스트 없이)
- 각 항목은 10자 이내 간결한 명사형 키워드
- 중복 없이 핵심 사업 3개
- 정보가 부족하면 기업명에서 유추

응답 예시: ["반도체 설계", "AI 솔루션", "전장부품"]"""

    for attempt in range(5):
        try:
            message = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=150,
                messages=[{"role": "user", "content": prompt}],
            )
            text = message.content[0].text.strip()
            start = text.find("[")
            end = text.rfind("]") + 1
            if start == -1 or end == 0:
                return None
            businesses = json.loads(text[start:end])
            return [str(b) for b in businesses[:3]]
        except Exception as e:
            err = str(e)
            if "rate_limit" in err or "429" in err:
                wait = 15 * (attempt + 1)
                print(f"rate_limit, wait {wait}s...", end=" ")
                time.sleep(wait)
            else:
                print(f"AI error: {e}")
                return None
    return None


# ────────────────────────────────────────────
# 4. DB 업데이트
# ────────────────────────────────────────────
def update_business_info(conn, stock_code: str, businesses: list[str]) -> bool:
    """companies 테이블의 business_info 컬럼을 업데이트"""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE companies
                SET business_info = %s::jsonb,
                    updated_at    = NOW()
                WHERE stock_code = %s
                  AND deleted_at IS NULL
                """,
                (json.dumps(businesses, ensure_ascii=False), stock_code),
            )
            updated = cur.rowcount
        conn.commit()
        return updated > 0
    except Exception as e:
        conn.rollback()
        print(f"    ❌ DB 업데이트 실패 ({stock_code}): {e}")
        return False


# ────────────────────────────────────────────
# 5. 메인 실행
# ────────────────────────────────────────────
def main():
    raw_path = Path("dart_raw.json")
    log_path = Path("dart_business_log.json")

    print("[INFO] dart_raw.json 로드...")
    with open(raw_path, encoding="utf-8") as f:
        raw = json.load(f)
    corps = raw["results"]
    print(f"[INFO] 총 {len(corps)}개 처리 대상")

    print("[INFO] DB connecting...")
    conn = psycopg2.connect(DB_URL)

    print("[INFO] Anthropic client init...")
    ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # 이미 처리된 stock_code 로드 (재시작 시 이어서 처리)
    done_codes = set()
    if log_path.exists():
        with open(log_path, encoding="utf-8") as f:
            prev = json.load(f)
        done_codes = {r["stock_code"] for r in prev.get("results", [])}
        results = prev.get("results", [])
        errors = prev.get("errors", [])
        print(f"[INFO] 이전 진행분 {len(done_codes)}개 스킵")
    else:
        results = []
        errors = []

    todo = [c for c in corps if c["stock_code"] not in done_codes]
    print(f"[INFO] 남은 처리 대상: {len(todo)}개")

    for i, corp in enumerate(todo, 1):
        corp_name = corp["corp_name"]
        stock_code = corp["stock_code"]
        induty_code = corp.get("induty_code", "")
        products = corp.get("products", "")

        print(f"[{i}/{len(todo)}] {corp_name} ({stock_code})", end=" ", flush=True)

        businesses = extract_businesses_with_ai(ai_client, corp_name, induty_code, products)
        if not businesses:
            print("SKIP (AI failed)")
            errors.append({**corp, "error": "AI 추출 실패"})
        else:
            updated = update_business_info(conn, stock_code, businesses)
            status = "OK" if updated else "NO_MATCH"
            print(f"{status} -> {businesses}")
            results.append({**corp, "businesses": businesses, "db_updated": updated})

        # Anthropic free tier: 분당 5회 → 12초 간격
        time.sleep(12)

        # 50개마다 중간 저장
        if i % 50 == 0:
            with open(log_path, "w", encoding="utf-8") as f:
                json.dump({"results": results, "errors": errors}, f, ensure_ascii=False, indent=2)
            print(f"[SAVE] {len(results)} ok / {len(errors)} fail")

    # 최종 저장
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump({"total": len(corps), "success": len(results), "failed": len(errors),
                   "results": results, "errors": errors}, f, ensure_ascii=False, indent=2)

    conn.close()
    print(f"[DONE] success={len(results)}, failed={len(errors)}")
    print(f"[FILE] {log_path.resolve()}")


if __name__ == "__main__":
    main()
