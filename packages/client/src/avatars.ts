/** Trainer avatars from the Showdown sprite set. */
import { showModal } from './modal.js';

const CDN = 'https://play.pokemonshowdown.com';

/** Curated, recognizable trainers (protagonists + champions). */
export const AVATARS = [
  'red', 'ethan', 'lyra', 'brendan', 'may', 'lucas', 'dawn',
  'hilbert', 'hilda', 'nate', 'rosa', 'calem', 'serena',
  'elio', 'selene', 'victor', 'gloria',
  'blue', 'lance', 'steven', 'cynthia', 'n', 'iris', 'wallace',
] as const;

export function trainerSpriteUrl(avatar: string): string {
  return `${CDN}/sprites/trainers/${avatar || 'red'}.png`;
}

export function showAvatarPicker(current: string, onPick: (avatar: string) => void): void {
  const grid = AVATARS.map((a) => `
    <button class="avatar-choice${a === current ? ' selected' : ''}" data-avatar="${a}" title="${a}">
      <img src="${trainerSpriteUrl(a)}" alt="${a}" width="64" height="64" loading="lazy" />
    </button>`).join('');
  const overlay = showModal({
    title: 'Choose your trainer',
    bodyHTML: `<div class="avatar-grid">${grid}</div>`,
    buttons: [{ label: 'Cancel' }],
    cardClass: 'modal-wide',
  });
  overlay.querySelectorAll('.avatar-choice').forEach((el) => {
    el.addEventListener('click', () => {
      onPick((el as HTMLElement).dataset['avatar']!);
      overlay.remove();
    });
  });
}
