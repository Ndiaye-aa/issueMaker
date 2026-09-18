import { jest } from '@jest/globals';
import { Semaphore, mapWithConcurrency } from '../src/util/concurrency.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('mapWithConcurrency', () => {
  it('preserva a ordem dos resultados mesmo com términos fora de ordem', async () => {
    const delays = [30, 5, 15];
    const result = await mapWithConcurrency(delays, 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `${index}:${delay}`;
    });
    expect(result).toEqual(['0:30', '1:5', '2:15']);
  });

  it('nunca ultrapassa o limite de execuções simultâneas', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    });
    expect(peak).toBe(3);
  });

  it('propaga a primeira falha e não inicia tarefas pendentes', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error('falhou');
        return item;
      }),
    ).rejects.toThrow('falhou');
    expect(started).toEqual([1, 2]);
  });

  it('retorna vazio sem chamar a função para lista vazia', async () => {
    const fn = jest.fn(async () => 1);
    expect(await mapWithConcurrency([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('Semaphore', () => {
  it('serializa quando o limite é 1 e libera o slot mesmo após erro', async () => {
    const semaphore = new Semaphore(1);
    const order: string[] = [];

    const first = semaphore.run(async () => {
      order.push('a:start');
      await tick();
      order.push('a:end');
      throw new Error('erro em a');
    });
    const second = semaphore.run(async () => {
      order.push('b:start');
    });

    await expect(first).rejects.toThrow('erro em a');
    await second;
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });
});
