import { describe, it, expect } from 'vitest';
import { isAllowedAssetPath } from '../src/asset-proxy.js';

/**
 * The /cdn proxy exists so sprites survive networks that block
 * play.pokemonshowdown.com. Its allowlist is the only thing standing between
 * that route and an open proxy, so it gets tested directly.
 */
describe('isAllowedAssetPath', () => {
  it('accepts every asset shape the client can produce', () => {
    for (const path of [
      'sprites/gen5/pikachu.png',
      'sprites/gen5-back/pikachu.png',
      'sprites/ani/pikachu.gif',
      'sprites/ani-back/pikachu.gif',
      'sprites/gen5/rotom-wash.png',        // hyphenated forme
      'sprites/ani/tapu-koko.gif',
      'sprites/trainers/red.png',
      'sprites/gen6bgs/bg-meadow.jpg',
      'fx/pokeball.png',
      'audio/cries/pikachu.mp3',
      'audio/dpp-trainer.mp3',
    ]) {
      expect(isAllowedAssetPath(path), path).toBe(true);
    }
  });

  it('rejects traversal, absolute URLs and anything off the allowlist', () => {
    for (const path of [
      '../../etc/passwd',
      'sprites/gen5/../../../package.json',
      'https://evil.example.com/x.png',
      '//evil.example.com/x.png',
      'sprites/gen5/pikachu.svg',           // extension not allowed
      'sprites/GEN5/pikachu.png',           // ids are lowercase
      'sprites/other/pikachu.png',          // directory not allowed
      'audio/cries/pika_chu.mp3',           // underscore is not a PS id char
      'audio/nested/dir/track.mp3',
      'index.html',
      '',
      `sprites/gen5/${'a'.repeat(80)}.png`, // length bound
    ]) {
      expect(isAllowedAssetPath(path), path).toBe(false);
    }
  });
});
