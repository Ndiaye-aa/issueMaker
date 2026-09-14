import { assignSprintDates, isIsoDate, parseSprintLengthDays, todayIsoDate } from '../src/plan/sprint-dates.js';

describe('parseSprintLengthDays', () => {
  it('reconhece semanas e dias em português e abreviações', () => {
    expect(parseSprintLengthDays('2 semanas')).toBe(14);
    expect(parseSprintLengthDays('1 semana')).toBe(7);
    expect(parseSprintLengthDays('10 dias')).toBe(10);
    expect(parseSprintLengthDays('10d')).toBe(10);
    expect(parseSprintLengthDays('3w')).toBe(21);
    expect(parseSprintLengthDays('Sprint de 2 Sem')).toBe(14);
  });

  it('devolve undefined para texto não reconhecido', () => {
    expect(parseSprintLengthDays('um mês')).toBeUndefined();
    expect(parseSprintLengthDays('0 dias')).toBeUndefined();
    expect(parseSprintLengthDays('')).toBeUndefined();
  });
});

describe('isIsoDate / todayIsoDate', () => {
  it('valida datas reais no formato YYYY-MM-DD', () => {
    expect(isIsoDate('2026-09-14')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('14/09/2026')).toBe(false);
  });

  it('todayIsoDate usa a data local', () => {
    expect(todayIsoDate(new Date(2026, 8, 14, 23, 30))).toBe('2026-09-14');
  });
});

describe('assignSprintDates', () => {
  const plan = {
    sprints: [
      { number: 1, goal: 'A', requirementIds: ['REQ-1'] },
      { number: 2, goal: 'B', requirementIds: ['REQ-2'] },
      { number: 3, goal: 'C', requirementIds: ['REQ-3'] },
    ],
  };

  it('atribui janelas sequenciais e sem sobreposição', () => {
    const dated = assignSprintDates(plan, '2026-09-14', 14);

    expect(dated.sprints.map((s) => [s.startDate, s.dueDate])).toEqual([
      ['2026-09-14', '2026-09-27'],
      ['2026-09-28', '2026-10-11'],
      ['2026-10-12', '2026-10-25'],
    ]);
    for (let i = 1; i < dated.sprints.length; i += 1) {
      expect(dated.sprints[i]!.startDate! > dated.sprints[i - 1]!.dueDate!).toBe(true);
    }
  });

  it('atravessa virada de ano e mantém o resto do plano', () => {
    const dated = assignSprintDates({ ...plan, warnings: ['x'] }, '2026-12-28', 7);
    expect(dated.sprints[0]).toEqual({ number: 1, goal: 'A', requirementIds: ['REQ-1'], startDate: '2026-12-28', dueDate: '2027-01-03' });
    expect(dated.warnings).toEqual(['x']);
  });

  it('rejeita data ou duração inválidas', () => {
    expect(() => assignSprintDates(plan, '2026-13-01', 14)).toThrow(/YYYY-MM-DD/);
    expect(() => assignSprintDates(plan, '2026-09-14', 0)).toThrow(/duração/);
  });
});
