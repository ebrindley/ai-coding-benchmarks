const utils = require('..');

describe('js utils commonjs fixture', () => {
  test('capitalize', () => {
    expect(utils.capitalize('hello')).toBe('Hello');
    expect(utils.capitalize('')).toBe('');
  });

  test('kebabCase', () => {
    expect(utils.kebabCase('HelloWorld')).toBe('hello-world');
    expect(utils.kebabCase('hello world')).toBe('hello-world');
  });

  test('unique + chunk', () => {
    expect(utils.unique([1, 1, 2, 3, 3])).toEqual([1, 2, 3]);
    expect(utils.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('pick + isPlainObject', () => {
    expect(utils.pick({ a: 1, b: 2 }, ['b', 'c'])).toEqual({ b: 2 });
    expect(utils.isPlainObject({})).toBe(true);
    expect(utils.isPlainObject([])).toBe(false);
  });

  test('async helpers', async () => {
    await expect(utils.withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
    await expect(
      utils.withTimeout(
        utils.delay(20).then(() => 'done'),
        50
      )
    ).resolves.toBe('done');
    await expect(utils.withTimeout(utils.delay(50), 10)).rejects.toThrow('timeout');
  });
});
