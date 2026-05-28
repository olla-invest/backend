import { BadRequestException, PipeTransform } from '@nestjs/common';

const DATE_RE = /^\d{8}$|^\d{4}-\d{2}-\d{2}$|^\d{4}-\d{2}-\d{2}T/;
const STOCK_CODE_RE = /^\d{6}$/;

export class RegexPipe implements PipeTransform {
  constructor(
    private readonly regex: RegExp,
    private readonly label: string,
    private readonly optional = false,
  ) {}

  transform(value: unknown) {
    if (value == null || value === '') {
      if (this.optional) return undefined;
      throw new BadRequestException(`${this.label} is required`);
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${this.label} must be a string`);
    }

    const normalized = value.trim();
    if (!this.regex.test(normalized)) {
      throw new BadRequestException(`Invalid ${this.label}`);
    }

    return normalized;
  }
}

export class StockCodePipe extends RegexPipe {
  constructor(optional = false) {
    super(STOCK_CODE_RE, 'stockCode', optional);
  }
}

export class DateStringPipe extends RegexPipe {
  constructor(label = 'date', optional = false) {
    super(DATE_RE, label, optional);
  }
}

export class EnumPipe<T extends string> implements PipeTransform {
  constructor(
    private readonly allowed: readonly T[],
    private readonly label: string,
    private readonly optional = false,
  ) {}

  transform(value: unknown): T | undefined {
    if (value == null || value === '') {
      if (this.optional) return undefined;
      throw new BadRequestException(`${this.label} is required`);
    }

    if (typeof value !== 'string' || !this.allowed.includes(value as T)) {
      throw new BadRequestException(`Invalid ${this.label}`);
    }

    return value as T;
  }
}

export class IntRangePipe implements PipeTransform {
  constructor(
    private readonly label: string,
    private readonly min: number,
    private readonly max: number,
    private readonly optional = false,
  ) {}

  transform(value: unknown): number | undefined {
    if (value == null || value === '') {
      if (this.optional) return undefined;
      throw new BadRequestException(`${this.label} is required`);
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(numeric) || numeric < this.min || numeric > this.max) {
      throw new BadRequestException(`${this.label} must be an integer between ${this.min} and ${this.max}`);
    }

    return numeric;
  }
}

export class NumberRangePipe implements PipeTransform {
  constructor(
    private readonly label: string,
    private readonly min: number,
    private readonly max: number,
    private readonly optional = false,
  ) {}

  transform(value: unknown): number | undefined {
    if (value == null || value === '') {
      if (this.optional) return undefined;
      throw new BadRequestException(`${this.label} is required`);
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < this.min || numeric > this.max) {
      throw new BadRequestException(`${this.label} must be a number between ${this.min} and ${this.max}`);
    }

    return numeric;
  }
}

export class CsvIntPipe implements PipeTransform {
  constructor(
    private readonly label: string,
    private readonly min: number,
    private readonly max: number,
    private readonly optional = true,
    private readonly maxItems = 20,
  ) {}

  transform(value: unknown): string | undefined {
    if (value == null || value === '') {
      if (this.optional) return undefined;
      throw new BadRequestException(`${this.label} is required`);
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${this.label} must be a comma-separated string`);
    }

    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0 || parts.length > this.maxItems) {
      throw new BadRequestException(`Invalid ${this.label}`);
    }

    for (const part of parts) {
      const numeric = Number(part);
      if (!Number.isInteger(numeric) || numeric < this.min || numeric > this.max) {
        throw new BadRequestException(`${this.label} contains an invalid value`);
      }
    }

    return parts.join(',');
  }
}

export class CsvDatePipe implements PipeTransform {
  constructor(
    private readonly label: string,
    private readonly optional = true,
    private readonly maxItems = 20,
  ) {}

  transform(value: unknown): string | undefined {
    if (value == null || value === '') {
      if (this.optional) return undefined;
      throw new BadRequestException(`${this.label} is required`);
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${this.label} must be a comma-separated string`);
    }

    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0 || parts.length > this.maxItems || parts.some((part) => !DATE_RE.test(part))) {
      throw new BadRequestException(`Invalid ${this.label}`);
    }

    return parts.join(',');
  }
}

export class StockCodeArrayPipe implements PipeTransform {
  constructor(private readonly optional = false, private readonly maxItems = 100) {}

  transform(value: unknown): string[] | undefined {
    if (value == null) {
      if (this.optional) return undefined;
      throw new BadRequestException('stockCodes is required');
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > this.maxItems) {
      throw new BadRequestException('stockCodes must be a non-empty array');
    }

    return value.map((item) => {
      if (typeof item !== 'string' || !STOCK_CODE_RE.test(item.trim())) {
        throw new BadRequestException('stockCodes contains an invalid stockCode');
      }
      return item.trim();
    });
  }
}

export class EnumArrayPipe<T extends string> implements PipeTransform {
  constructor(
    private readonly allowed: readonly T[],
    private readonly label: string,
    private readonly optional = false,
    private readonly maxItems = 20,
  ) {}

  transform(value: unknown): T[] | undefined {
    if (value == null) {
      if (this.optional) return undefined;
      throw new BadRequestException(`${this.label} is required`);
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > this.maxItems) {
      throw new BadRequestException(`${this.label} must be a non-empty array`);
    }

    return value.map((item) => {
      if (typeof item !== 'string' || !this.allowed.includes(item as T)) {
        throw new BadRequestException(`${this.label} contains an invalid value`);
      }
      return item as T;
    });
  }
}

export class StockListFiltersPipe implements PipeTransform {
  transform(value: unknown): { isHighPrice?: boolean; minTradingValue?: number; theme?: number[] } | undefined {
    if (value == null) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('filters must be an object');
    }

    const candidate = value as Record<string, unknown>;
    const allowedKeys = new Set(['isHighPrice', 'minTradingValue', 'theme']);
    for (const key of Object.keys(candidate)) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException(`filters contains unsupported field: ${key}`);
      }
    }

    const filters: { isHighPrice?: boolean; minTradingValue?: number; theme?: number[] } = {};
    if (candidate.isHighPrice !== undefined) {
      if (typeof candidate.isHighPrice !== 'boolean') {
        throw new BadRequestException('filters.isHighPrice must be boolean');
      }
      filters.isHighPrice = candidate.isHighPrice;
    }
    if (candidate.minTradingValue !== undefined) {
      const minTradingValue = Number(candidate.minTradingValue);
      if (!Number.isFinite(minTradingValue) || minTradingValue < 0 || minTradingValue > 1_000_000_000_000_000) {
        throw new BadRequestException('filters.minTradingValue is invalid');
      }
      filters.minTradingValue = minTradingValue;
    }
    if (candidate.theme !== undefined) {
      if (!Array.isArray(candidate.theme) || candidate.theme.length > 50) {
        throw new BadRequestException('filters.theme must be an array');
      }
      filters.theme = candidate.theme.map((themeCode) => {
        const numeric = Number(themeCode);
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > 999999) {
          throw new BadRequestException('filters.theme contains an invalid value');
        }
        return numeric;
      });
    }

    return filters;
  }
}

export class RsFiltersPipe implements PipeTransform {
  constructor(private readonly optional = true, private readonly maxItems = 5) {}

  transform(value: unknown): Array<{ rsStartDate: string; rsEndDate: string; strength: number }> | undefined {
    if (value == null) {
      if (this.optional) return undefined;
      throw new BadRequestException('rsFilters is required');
    }
    if (!Array.isArray(value) || value.length > this.maxItems) {
      throw new BadRequestException(`rsFilters must be an array with at most ${this.maxItems} items`);
    }

    return value.map((filter) => {
      if (!filter || typeof filter !== 'object') {
        throw new BadRequestException('Invalid rsFilters item');
      }
      const candidate = filter as Record<string, unknown>;
      const rsStartDate = String(candidate.rsStartDate ?? '').trim();
      const rsEndDate = String(candidate.rsEndDate ?? '').trim();
      const strength = Number(candidate.strength);

      if (!DATE_RE.test(rsStartDate) || !DATE_RE.test(rsEndDate)) {
        throw new BadRequestException('Invalid rsFilters date');
      }
      if (!Number.isFinite(strength) || strength < 0 || strength > 100) {
        throw new BadRequestException('rsFilters strength must be between 0 and 100');
      }

      return { rsStartDate, rsEndDate, strength };
    });
  }
}
