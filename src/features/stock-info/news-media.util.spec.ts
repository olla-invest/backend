import { convertOriginUrlToMediaName } from './news-media.util';

describe('convertOriginUrlToMediaName', () => {
  it('matches registered media by normalized host', () => {
    expect(convertOriginUrlToMediaName('https://www.HANKYUNG.com/article/1')).toBe('한국경제');
  });

  it('matches newly registered media hosts from news origin URLs', () => {
    expect(convertOriginUrlToMediaName('https://www.thebell.co.kr/free/content/ArticleView.asp?key=1')).toBe('더벨');
    expect(convertOriginUrlToMediaName('https://www.pinpointnews.co.kr/news/articleView.html?idxno=1')).toBe('핀포인트뉴스');
  });

  it('matches additional media hosts found from top RS news responses', () => {
    expect(convertOriginUrlToMediaName('https://www.itooza.com/newsview/1')).toBe('아이투자');
    expect(convertOriginUrlToMediaName('https://www.topstarnews.net/news/articleView.html?idxno=1')).toBe('톱스타뉴스');
    expect(convertOriginUrlToMediaName('https://biz.newdaily.co.kr/site/data/html/2026/05/15/1.html')).toBe('뉴데일리경제');
    expect(convertOriginUrlToMediaName('https://news.einfomax.co.kr/news/articleView.html?idxno=1')).toBe('연합인포맥스');
  });

  it('matches subdomains of registered hosts', () => {
    expect(convertOriginUrlToMediaName('https://sports.khan.co.kr/news/1')).toBe('경향신문');
  });

  it('prefers path-prefixed media before the host-only media', () => {
    expect(convertOriginUrlToMediaName('https://www.mk.co.kr/economy/view/1')).toBe('매경이코노미');
    expect(convertOriginUrlToMediaName('https://www.mk.co.kr/news/business/1')).toBe('매일경제');
  });

  it('returns an empty string for unmatched or invalid URLs', () => {
    expect(convertOriginUrlToMediaName('https://example.com/news/1')).toBe('');
    expect(convertOriginUrlToMediaName('not-a-url')).toBe('');
    expect(convertOriginUrlToMediaName(undefined)).toBe('');
  });
});
