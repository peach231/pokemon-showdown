import { describe, it, expect } from 'vitest';
import { typeEffectiveness, singleTypeEffectiveness } from '../src/index.js';

describe('type effectiveness', () => {
  it('handles single-type matchups', () => {
    expect(singleTypeEffectiveness('Fire', 'Grass')).toBe(2);
    expect(singleTypeEffectiveness('Fire', 'Water')).toBe(0.5);
    expect(singleTypeEffectiveness('Water', 'Fire')).toBe(2);
    expect(singleTypeEffectiveness('Normal', 'Ghost')).toBe(0);
    expect(singleTypeEffectiveness('Electric', 'Ground')).toBe(0);
    expect(singleTypeEffectiveness('Normal', 'Fighting')).toBe(1);
  });

  it('multiplies across dual types', () => {
    expect(typeEffectiveness('Electric', ['Water', 'Flying'])).toBe(4);
    expect(typeEffectiveness('Ice', ['Grass', 'Dragon'])).toBe(4);
    expect(typeEffectiveness('Fighting', ['Rock', 'Flying'])).toBe(1); // 2 * 0.5
    expect(typeEffectiveness('Ground', ['Steel', 'Flying'])).toBe(0); // immune wins
    expect(typeEffectiveness('Grass', ['Bug', 'Steel'])).toBe(0.25); // 0.5 * 0.5
  });

  it('is neutral when no entry exists', () => {
    expect(typeEffectiveness('Normal', ['Normal'])).toBe(1);
  });
});
