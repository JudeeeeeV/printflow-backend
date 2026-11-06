import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

describe('OrdersService.calculatePrice', () => {
  const service = Object.create(OrdersService.prototype) as OrdersService;
  const calculate = (
    matrix: unknown,
    paper = 'A4',
    color = 'COLOR',
    pages: unknown = 5,
    copies?: number,
  ) =>
    (service as any).calculatePrice(
      matrix,
      paper,
      color,
      pages,
      ...(copies === undefined ? [] : [copies]),
    ) as number;

  const matrix = (base: unknown = 3, additive: unknown = 3) => ({
    paper_sizes: { A4: base },
    color_mode_multipliers: { COLOR: additive },
  });

  it.each([
    ['P01', matrix(), 'A4', 'COLOR', 5, 30],
    ['P02', matrix(3, 3), 'A4', 'COLOR', 0, null],
    ['P03', matrix(3, -1), 'A4', 'COLOR', 5, null],
    ['P04', matrix(3, -1), 'A4', 'COLOR', 0, null],
    ['P05', matrix(-1, 3), 'A4', 'COLOR', 5, null],
    ['P06', matrix(-1, 3), 'A4', 'COLOR', 0, null],
    ['P07', matrix(-1, -1), 'A4', 'COLOR', 5, null],
    ['P08', matrix(-1, -1), 'A4', 'COLOR', 0, null],
    ['P09', undefined, 'A4', 'COLOR', 5, null],
    ['P10', { color_mode_multipliers: { COLOR: 3 } }, 'A4', 'COLOR', 5, null],
    ['P11', { paper_sizes: { A4: 3 } }, 'A4', 'COLOR', 5, null],
    ['P12', matrix(), 'A3', 'COLOR', 5, null],
    ['P13', matrix(), 'A4', 'SEPIA', 5, null],
    ['P14', matrix('abc', 3), 'A4', 'COLOR', 5, null],
    ['P15', matrix(Infinity, 3), 'A4', 'COLOR', 5, null],
    ['P16', matrix(3, Infinity), 'A4', 'COLOR', 5, null],
    ['P17', matrix(), 'A4', 'COLOR', 1.5, null],
    ['P18', matrix(), 'A4', 'COLOR', '5', null],
    ['P19', matrix(), 'A4', 'COLOR', NaN, null],
    ['P20', matrix(0, 3), 'A4', 'COLOR', 5, 15],
    ['P21', matrix(1, 3), 'A4', 'COLOR', 5, 20],
    ['P22', matrix(3, 0), 'A4', 'COLOR', 5, 15],
    ['P23', matrix(3, 1), 'A4', 'COLOR', 5, 20],
    ['P24', matrix(), 'A4', 'COLOR', 1, 6],
    ['P25', matrix(), 'A4', 'COLOR', 2, 12],
    ['P26', matrix('3', '3'), 'A4', 'COLOR', 5, 30],
    ['P27', matrix(null, null), 'A4', 'COLOR', 5, 0],
    ['P28', matrix(0.333, 0.333), 'A4', 'COLOR', 3, 2],
    ['P29', matrix(Number.MAX_VALUE, 0), 'A4', 'COLOR', 1, Infinity],
    ['P30', matrix(), 'A4', 'COLOR', 1001, 6006],
  ])(
    '%s expected result',
    (_id, pricing, paper, color, pages, expected) => {
      if (expected === null) {
        expect(() => calculate(pricing, paper, color, pages)).toThrow(
          BadRequestException,
        );
      } else {
        expect(calculate(pricing, paper, color, pages)).toBe(expected);
      }
    },
  );

  it.each([
    ['C01', 1, 30],
    ['C02', 2, 60],
  ])('%s accepts a valid copy count', (_id, copies, expected) => {
    expect(calculate(matrix(), 'A4', 'COLOR', 5, copies)).toBe(expected);
  });

  it.each([['C03', 0], ['C04', 100]])(
    '%s rejects a copy count outside 1..99', (_id, copies) => {
      expect(() => calculate(matrix(), 'A4', 'COLOR', 5, copies)).toThrow(
        BadRequestException,
      );
    },
  );
});
