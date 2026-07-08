import { describe, it, expect } from 'vitest';
import {
  parseClientMessage, serializeClientMessage,
  serializeServerFrame, parseServerFrame,
  parseLine, buildLine, toID, isValidUsername, GLOBAL_ROOM,
} from '../src/index.js';

describe('client message framing', () => {
  it('round-trips a room message', () => {
    const raw = serializeClientMessage('lobby', 'hello world');
    expect(parseClientMessage(raw)).toEqual({ roomId: 'lobby', text: 'hello world' });
  });

  it('keeps pipes inside the text', () => {
    const msg = parseClientMessage('battle-1|/choose move 1');
    expect(msg.roomId).toBe('battle-1');
    expect(msg.text).toBe('/choose move 1');
    const withPipe = parseClientMessage('lobby|I like | pipes');
    expect(withPipe.text).toBe('I like | pipes');
  });

  it('empty room id means global', () => {
    expect(parseClientMessage('|/search').roomId).toBe(GLOBAL_ROOM);
  });
});

describe('server frame framing', () => {
  it('round-trips a room frame', () => {
    const frame = serializeServerFrame('battle-1', ['|turn|3', '|move|p1a: X|Tackle|p2a: Y']);
    const parsed = parseServerFrame(frame);
    expect(parsed.roomId).toBe('battle-1');
    expect(parsed.lines).toEqual(['|turn|3', '|move|p1a: X|Tackle|p2a: Y']);
  });

  it('omits the room prefix for the global room', () => {
    const frame = serializeServerFrame(GLOBAL_ROOM, ['|updateuser|Alice|1']);
    expect(frame.startsWith('>')).toBe(false);
    expect(parseServerFrame(frame)).toEqual({ roomId: GLOBAL_ROOM, lines: ['|updateuser|Alice|1'] });
  });
});

describe('line parsing', () => {
  it('splits protocol lines', () => {
    expect(parseLine('|move|p1a: X|Tackle|p2a: Y')).toEqual(['move', 'p1a: X', 'Tackle', 'p2a: Y']);
  });

  it('respects maxParts so chat keeps its pipes', () => {
    expect(parseLine('|c|Alice|hi | there', 3)).toEqual(['c', 'Alice', 'hi | there']);
  });

  it('builds lines', () => {
    expect(buildLine('turn', 5)).toBe('|turn|5');
  });
});

describe('identity helpers', () => {
  it('normalizes ids', () => {
    expect(toID('Mr. Mime')).toBe('mrmime');
    expect(toID('ALICE!!')).toBe('alice');
  });

  it('validates usernames', () => {
    expect(isValidUsername('Alice')).toBe(true);
    expect(isValidUsername('')).toBe(false);
    expect(isValidUsername('a|b')).toBe(false);
    expect(isValidUsername('Guest 55')).toBe(false);
    expect(isValidUsername('x'.repeat(19))).toBe(false);
  });
});
