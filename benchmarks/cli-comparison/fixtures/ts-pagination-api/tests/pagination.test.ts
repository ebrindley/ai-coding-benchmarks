import { describe, expect, test } from '@jest/globals';
import { UserRepository } from '../src/repositories/user.repository';

function ids(list: { id: number }[]): number[] {
  return list.map((u) => u.id);
}

describe('pagination fixture', () => {
  test('correct-page-contents', () => {
    const repo = new UserRepository();

    expect(ids(repo.findAll({ page: 1, pageSize: 10 }))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ids(repo.findAll({ page: 2, pageSize: 10 }))).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  test('no-duplicates-across-pages', () => {
    const repo = new UserRepository();
    const page1 = ids(repo.findAll({ page: 1, pageSize: 10 }));
    const page2 = ids(repo.findAll({ page: 2, pageSize: 10 }));
    const intersection = page1.filter((id) => page2.includes(id));
    expect(intersection).toEqual([]);
  });

  test('stable-ordering', () => {
    const repo = new UserRepository();
    const first = ids(repo.findAll({ page: 1, pageSize: 10 }));
    const second = ids(repo.findAll({ page: 1, pageSize: 10 }));
    expect(second).toEqual(first);
  });
});
