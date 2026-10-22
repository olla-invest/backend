import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

/** 1 … 6 7 8 9 형태: 첫 페이지와 현재 페이지 주변 최대 4개를 보여준다. */
function pageItems(page: number, totalPages: number): Array<number | 'gap'> {
  const windowSize = 4;
  let start = Math.max(1, page - 1);
  let end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);

  const items: Array<number | 'gap'> = [];
  if (start > 1) {
    items.push(1);
    if (start > 2) items.push('gap');
  }
  for (let current = start; current <= end; current += 1) items.push(current);
  if (end < totalPages) {
    if (end < totalPages - 1) items.push('gap');
    items.push(totalPages);
  }
  return items;
}

export function Pagination({ page, totalPages, onChange }: PaginationProps) {
  return (
    <nav className="pagination" aria-label="페이지 이동">
      <button type="button" className="page-button page-nav" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <ChevronLeft size={16} /> 이전
      </button>
      {pageItems(page, totalPages).map((item, index) =>
        item === 'gap' ? (
          <span key={`gap-${index}`} className="page-button page-gap">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            className={`page-button${item === page ? ' is-current' : ''}`}
            aria-current={item === page ? 'page' : undefined}
            onClick={() => onChange(item)}
          >
            {item}
          </button>
        ),
      )}
      <button
        type="button"
        className="page-button page-nav"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        다음 <ChevronRight size={16} />
      </button>
    </nav>
  );
}
