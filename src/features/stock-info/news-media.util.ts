const originUrlToMediaName: Record<string, string> = {
  'https://www.khan.co.kr': '경향신문',
  'https://www.kmib.co.kr': '국민일보',
  'https://www.donga.com': '동아일보',
  'https://www.munhwa.com': '문화일보',
  'https://www.seoul.co.kr': '서울신문',
  'https://www.segye.com': '세계일보',
  'https://www.chosun.com': '조선일보',
  'https://www.joongang.co.kr': '중앙일보',
  'https://www.hani.co.kr': '한겨레',
  'https://www.hankookilbo.com': '한국일보',
  'https://www.news1.kr': '뉴스1',
  'https://www.newsis.com': '뉴시스',
  'https://www.thebell.co.kr': '더벨',
  'https://www.newspim.com': '뉴스핌',
  'https://www.yna.co.kr': '연합뉴스',
  'https://www.yonhapnewstv.co.kr': '연합뉴스TV',
  'https://www.ichannela.com': '채널A',
  'https://www.wowtv.co.kr': '한국경제TV',
  'https://www.jtbc.co.kr': 'JTBC',
  'https://www.kbs.co.kr': 'KBS',
  'https://www.mbc.co.kr': 'MBC',
  'https://www.mbn.co.kr': 'MBN',
  'https://biz.sbs.co.kr': 'SBS Biz',
  'https://www.sbs.co.kr': 'SBS',
  'https://www.tvchosun.com': 'TV조선',
  'https://www.ytn.co.kr': 'YTN',
  'https://www.mk.co.kr/economy': '매경이코노미',
  'https://www.mk.co.kr': '매일경제',
  'https://www.mt.co.kr': '머니투데이',
  'https://news.bizwatch.co.kr': '비즈워치',
  'https://www.sedaily.com': '서울경제',
  'https://www.asiae.co.kr': '아시아경제',
  'https://www.edaily.co.kr': '이데일리',
  'https://biz.chosun.com': '조선비즈',
  'https://www.joseilbo.com': '조세일보',
  'https://www.fnnews.com': '파이낸셜뉴스',
  'https://www.hankyung.com': '한국경제',
  'https://news.heraldcorp.com': '헤럴드경제',
  'https://www.nocutnews.co.kr': '노컷뉴스',
  'https://www.tf.co.kr': '더팩트',
  'https://www.dailian.co.kr': '데일리안',
  'https://www.ajunews.com': '아주경제',
  'https://www.businesspost.co.kr': '비즈니스포스트',
  'https://www.siminilbo.co.kr': '동행미디어 시대',
  'https://www.mediatoday.co.kr': '미디어오늘',
  'https://www.inews24.com': '아이뉴스24',
  'https://www.ohmynews.com': '오마이뉴스',
  'https://www.pinpointnews.co.kr': '핀포인트뉴스',
  'https://www.pressian.com': '프레시안',
  'https://www.shinailbo.co.kr': '신아일보',
  'https://www.ddaily.co.kr': '디지털데일리',
  'https://www.dt.co.kr': '디지털타임스',
  'https://www.bloter.net': '블로터',
  'https://www.etnews.com': '전자신문',
  'https://www.ebn.co.kr': 'EBN',
  'https://zdnet.co.kr': '지디넷코리아',
  'https://www.thescoop.co.kr': '더스쿠프',
  'https://lady.khan.co.kr': '레이디경향',
  'https://www.sisain.co.kr': '시사IN',
  'https://www.sisajournal.com': '시사저널',
  'https://shindonga.donga.com': '신동아',
  'https://san.chosun.com': '월간 산',
  'https://economist.co.kr': '이코노미스트',
  'https://weekly.khan.co.kr': '주간경향',
  'https://weekly.donga.com': '주간동아',
  'https://weekly.chosun.com': '주간조선',
  'https://www.joongang.co.kr/sunday': '중앙SUNDAY',
  'https://h21.hani.co.kr': '한겨레21',
  'https://magazine.hankyung.com/business': '한경비즈니스',
  'https://www.journalist.or.kr': '기자협회보',
  'https://www.nongmin.com': '농민신문',
  'https://www.ggilbo.com': '금강일보',
  'https://newstapa.org': '뉴스타파',
  'https://www.dongascience.com': '동아사이언스',
  'https://www.womennews.co.kr': '여성신문',
  'https://www.ildaro.com': '일다',
  'https://koreajoongangdaily.joins.com': '코리아중앙데일리',
  'https://www.koreaherald.com': '코리아헤럴드',
  'https://www.kormedi.com': '코메디닷컴',
  'https://health.chosun.com': '헬스조선',
  'https://www.kado.net': '강원도민일보',
  'https://www.kwnews.co.kr': '강원일보',
  'https://www.kyeonggi.com': '경기일보',
  'https://www.kookje.co.kr': '국제신문',
  'https://daegu.mbc.co.kr': '대구MBC',
  'https://www.daejonilbo.com': '대전일보',
  'https://www.imaeil.com': '매일신문',
  'https://www.busan.com': '부산일보',
  'https://jeonju.mbc.co.kr': '전주MBC',
  'https://www.cjb.co.kr': 'CJB청주방송',
  'https://www.jibs.co.kr': 'JIBS',
  'https://www.ikbc.co.kr': 'kbc광주방송',
  'https://www.4th.kr': '포쓰저널',
  'https://www.catchnews.kr': '캐치뉴스',
  'https://www.cbci.co.kr': 'CBC뉴스',
  'https://www.choicenews.co.kr': '초이스경제',
  'https://www.cnbizm.com': 'CNB저널',
  'https://www.dailysmart.co.kr': '데일리스마트',
  'https://www.dealsite.co.kr': '딜사이트',
  'https://news.dealsitetv.com': '딜사이트TV',
  'https://www.econonews.co.kr': '이코노뉴스',
  'https://www.enetnews.co.kr': '이넷뉴스',
  'https://www.enewstoday.co.kr': '이뉴스투데이',
  'https://www.energy-news.co.kr': '에너지신문',
  'https://www.e-platform.net': '에너지플랫폼뉴스',
  'https://www.etoday.co.kr': '이투데이',
  'https://www.fieldnews.kr': '필드뉴스',
  'https://www.financialreview.co.kr': '파이낸셜리뷰',
  'https://www.g-enews.com': '글로벌이코노믹',
  'https://www.gukjenews.com': '국제뉴스',
  'https://www.hansbiz.co.kr': '한스경제',
  'https://www.investchosun.com': '인베스트조선',
  'https://www.itooza.com': '아이투자',
  'https://www.joongangenews.com': '중앙이코노미뉴스',
  'https://biz.newdaily.co.kr': '뉴데일리경제',
  'https://www.kdpress.co.kr': '데일리경제',
  'https://www.kmecnews.co.kr': 'KMEC News',
  'https://www.kpinews.kr': 'KPI뉴스',
  'https://www.ksilbo.co.kr': '경상일보',
  'https://www.kukinews.com': '쿠키뉴스',
  'https://www.news2day.co.kr': '뉴스투데이',
  'https://www.newsdream.kr': '뉴스드림',
  'https://news.einfomax.co.kr': '연합인포맥스',
  'https://www.newsquest.co.kr': '뉴스퀘스트',
  'https://www.newslock.co.kr': '뉴스락',
  'https://www.newsprime.co.kr': '프라임경제',
  'https://www.newstnt.com': '뉴스티앤티',
  'https://www.newstopkorea.com': '뉴스톱코리아',
  'https://www.ngetnews.com': '뉴스저널리즘',
  'https://www.pointdaily.co.kr': '포인트데일리',
  'https://www.public25.com': '공공뉴스',
  'https://www.sentv.co.kr': '서울경제TV',
  'https://www.seouleconews.com': '서울이코노미뉴스',
  'https://www.slist.kr': '싱글리스트',
  'https://www.the-biz.co.kr': '더비즈',
  'https://www.thelec.kr': '디일렉',
  'https://www.thepublic.kr': '더퍼블릭',
  'https://www.theviewers.co.kr': '뷰어스',
  'https://www.topstarnews.net': '톱스타뉴스',
  'https://www.viva100.com': '브릿지경제',
  'https://www.webeconomy.co.kr': '웹이코노미',
  'https://www.widedaily.com': '와이드경제',
  'https://www.worktoday.co.kr': '워크투데이',
  'https://www.ziksir.com': '직썰',
};

type MediaMatcher = {
  host: string;
  path: string;
  mediaName: string;
};

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '';
  return pathname.replace(/\/+$/, '');
}

function hasPathPrefix(pathname: string, prefix: string): boolean {
  return !prefix || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const mediaMatchers: MediaMatcher[] = Object.entries(originUrlToMediaName)
  .map(([url, mediaName]) => {
    const parsed = new URL(url);
    return {
      host: normalizeHost(parsed.hostname),
      path: normalizePath(parsed.pathname),
      mediaName,
    };
  })
  .sort((a, b) => b.host.length - a.host.length || b.path.length - a.path.length);

export function convertOriginUrlToMediaName(originUrl?: string | null): string {
  if (!originUrl) return '';

  let parsed: URL;
  try {
    parsed = new URL(originUrl);
  } catch {
    return '';
  }

  const host = normalizeHost(parsed.hostname);
  const path = normalizePath(parsed.pathname);

  const match = mediaMatchers.find((matcher) => {
    const hostMatches = host === matcher.host || host.endsWith(`.${matcher.host}`);
    return hostMatches && hasPathPrefix(path, matcher.path);
  });

  return match?.mediaName ?? '';
}
