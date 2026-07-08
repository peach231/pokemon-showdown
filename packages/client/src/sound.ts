/**
 * Battle audio:
 *  - Looping BGM (real Showdown tracks, loop points from the PS client source)
 *  - Pokémon cries (per-species mp3s from the CDN)
 *  - Synthesized retro SFX for every move and hit (WebAudio, no assets)
 *
 * Real PS has NO move/hit sound files — its battles are cries + music only.
 * We synthesize Game-Boy-style effects so every attack and every hit is
 * guaranteed to make a sound, tinted by move category and type for variety.
 *
 * The critical detail: a WebAudio AudioContext created outside a user gesture
 * starts SUSPENDED and only unblocks when resume() is called from within a
 * gesture handler. We do exactly that on the first pointer/key event, so all
 * synthesized SFX reliably play (this was the "hits are silent" bug).
 */
import { cryUrl } from './sprites.js';

interface BgmTrack {
  url: string;
  loopStart: number;
  loopEnd: number;
}

const CDN = 'https://play.pokemonshowdown.com';

const BGM_TRACKS: BgmTrack[] = [
  { url: `${CDN}/audio/dpp-trainer.mp3`, loopStart: 13440, loopEnd: 96959 },
  { url: `${CDN}/audio/hgss-johto-trainer.mp3`, loopStart: 23731, loopEnd: 125086 },
  { url: `${CDN}/audio/bw-trainer.mp3`, loopStart: 14629, loopEnd: 110109 },
  { url: `${CDN}/audio/bw-rival.mp3`, loopStart: 19180, loopEnd: 57373 },
  { url: `${CDN}/audio/bw2-rival.mp3`, loopStart: 7152, loopEnd: 68708 },
  { url: `${CDN}/audio/xy-trainer.mp3`, loopStart: 7802, loopEnd: 82469 },
  { url: `${CDN}/audio/oras-trainer.mp3`, loopStart: 13579, loopEnd: 91548 },
];

export type HitKind = 'normal' | 'super' | 'resisted';
export type MoveCategory = 'Physical' | 'Special' | 'Status';

/** Move types grouped into synth "families" that share a sound character. */
const TYPE_TONE: Record<string, { wave: OscillatorType; freq: number }> = {
  Electric: { wave: 'square', freq: 900 }, Dragon: { wave: 'sawtooth', freq: 320 },
  Psychic: { wave: 'sine', freq: 720 }, Fairy: { wave: 'triangle', freq: 840 },
  Ghost: { wave: 'sine', freq: 260 }, Dark: { wave: 'sawtooth', freq: 200 },
  Fire: { wave: 'sawtooth', freq: 520 }, Water: { wave: 'sine', freq: 440 },
  Ice: { wave: 'triangle', freq: 1000 }, Grass: { wave: 'triangle', freq: 480 },
  Poison: { wave: 'square', freq: 340 }, Steel: { wave: 'square', freq: 600 },
  Normal: { wave: 'triangle', freq: 500 }, Flying: { wave: 'sine', freq: 660 },
  Ground: { wave: 'sawtooth', freq: 180 }, Rock: { wave: 'square', freq: 240 },
  Fighting: { wave: 'sawtooth', freq: 300 }, Bug: { wave: 'square', freq: 560 },
};

/**
 * Global, HMR-proof audio handles. Dev hot-reloads re-instantiate this module;
 * a module-scoped handle would orphan the playing track / AudioContext.
 */
interface GlobalAudioState {
  bgm: HTMLAudioElement | null;
  live: Set<HTMLAudioElement>;
  ctx: AudioContext | null;
}
function audioState(): GlobalAudioState {
  const g = globalThis as { __ssAudio?: GlobalAudioState };
  g.__ssAudio ??= { bgm: null, live: new Set(), ctx: null };
  return g.__ssAudio;
}

class SoundManager {
  muted = localStorage.getItem('ss-muted') === '1';

  constructor() {
    // On the first (and every) user gesture: unblock BGM AND resume the
    // WebAudio context. Resuming from inside a gesture is what makes all
    // synthesized SFX actually play.
    const unlock = () => {
      const state = audioState();
      if (state.bgm && state.bgm.paused && state.bgm.src) {
        void state.bgm.play().catch(() => { /* still blocked */ });
      }
      const ctx = this.ensureCtx();
      if (ctx && ctx.state === 'suspended') void ctx.resume();
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  private ensureCtx(): AudioContext | null {
    const state = audioState();
    if (!state.ctx) {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        state.ctx = new Ctor();
      } catch {
        state.ctx = null;
      }
    }
    return state.ctx;
  }

  /** A running context, or null if WebAudio is unavailable/not yet unlocked. */
  private ctx(): AudioContext | null {
    const ctx = this.ensureCtx();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  toggleMuted(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('ss-muted', this.muted ? '1' : '0');
    const state = audioState();
    if (state.bgm) state.bgm.muted = this.muted;
    for (const audio of state.live) audio.muted = this.muted;
    return this.muted;
  }

  // ------------------------------------------------------------------
  // BGM
  // ------------------------------------------------------------------

  playBgm(): void {
    this.stopBgm();
    const track = BGM_TRACKS[Math.floor(Math.random() * BGM_TRACKS.length)]!;
    const audio = new Audio(track.url);
    audio.volume = 0.18;
    audio.muted = this.muted;
    audio.addEventListener('timeupdate', () => {
      if (audio.currentTime * 1000 >= track.loopEnd) audio.currentTime = track.loopStart / 1000;
    });
    audio.addEventListener('ended', () => {
      audio.currentTime = track.loopStart / 1000;
      void audio.play().catch(() => { /* tab hidden */ });
    });
    audioState().bgm = audio;
    void audio.play().catch(() => { /* autoplay blocked; gesture unlock covers it */ });
  }

  stopBgm(): void {
    const state = audioState();
    if (state.bgm) {
      state.bgm.pause();
      state.bgm.removeAttribute('src');
      state.bgm = null;
    }
  }

  // ------------------------------------------------------------------
  // Cries
  // ------------------------------------------------------------------

  cry(species: string): void {
    if (this.muted) return;
    try {
      const audio = new Audio(cryUrl(species));
      audio.volume = 0.4;
      const state = audioState();
      state.live.add(audio);
      audio.addEventListener('ended', () => state.live.delete(audio));
      void audio.play().catch(() => state.live.delete(audio));
    } catch { /* no audio */ }
  }

  // ------------------------------------------------------------------
  // Synth helpers
  // ------------------------------------------------------------------

  private noiseBurst(ctx: AudioContext, dur: number, cutoffFrom: number, cutoffTo: number, vol: number): void {
    const now = ctx.currentTime;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * dur)), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoffFrom, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoffTo), now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.start(now);
    noise.stop(now + dur + 0.02);
  }

  private tone(ctx: AudioContext, wave: OscillatorType, f0: number, f1: number, dur: number, vol: number): void {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  // ------------------------------------------------------------------
  // Battle SFX — one guaranteed sound per move, one per hit
  // ------------------------------------------------------------------

  /** Played the instant a move is used (so even misses/status make noise). */
  attack(category: MoveCategory, type: string): void {
    if (this.muted) return;
    const ctx = this.ctx();
    if (!ctx) return;
    const tone = TYPE_TONE[type] ?? TYPE_TONE['Normal']!;
    if (category === 'Physical') {
      // Wind-up whoosh, tinted low by type.
      this.noiseBurst(ctx, 0.18, 900 + tone.freq * 0.3, 300, 0.18);
      this.tone(ctx, 'triangle', tone.freq * 0.9, tone.freq * 0.5, 0.12, 0.08);
    } else if (category === 'Special') {
      // Charged "pew" that rises then the projectile flies.
      this.tone(ctx, tone.wave, tone.freq * 0.7, tone.freq * 1.6, 0.1, 0.12);
      this.tone(ctx, tone.wave, tone.freq * 1.6, tone.freq * 0.8, 0.16, 0.1);
    } else {
      // Status: a soft ascending two-note sparkle.
      this.tone(ctx, 'sine', tone.freq, tone.freq * 1.5, 0.14, 0.09);
      this.tone(ctx, 'sine', tone.freq * 1.5, tone.freq * 2, 0.1, 0.06);
    }
  }

  /** Played when damage actually lands; louder/brighter for super effective. */
  hit(kind: HitKind): void {
    if (this.muted) return;
    const ctx = this.ctx();
    if (!ctx) return;
    const dur = kind === 'super' ? 0.28 : kind === 'resisted' ? 0.12 : 0.16;
    const cutoff = kind === 'super' ? 3200 : kind === 'resisted' ? 500 : 1400;
    const vol = kind === 'super' ? 0.5 : kind === 'resisted' ? 0.24 : 0.34;
    this.noiseBurst(ctx, dur, cutoff, 200, vol);
    if (kind === 'super') {
      // Descending square "zap" under the impact — the classic thwack.
      this.tone(ctx, 'square', 880, 120, 0.24, 0.16);
    } else if (kind === 'normal') {
      this.tone(ctx, 'square', 300, 90, 0.1, 0.08);
    }
  }

  /** Faint: a short descending tone. */
  faint(): void {
    if (this.muted) return;
    const ctx = this.ctx();
    if (!ctx) return;
    this.tone(ctx, 'triangle', 500, 80, 0.5, 0.14);
  }

  /** Victory: a tiny 3-note fanfare. */
  victory(): void {
    if (this.muted) return;
    const ctx = this.ctx();
    if (!ctx) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => setTimeout(() => {
      const c = this.ctx();
      if (c) this.tone(c, 'square', n, n, 0.16, 0.12);
    }, i * 130));
  }
}

export const Sound = new SoundManager();
