/** Retro game-dialog modals (replaces browser prompt()/confirm()). */

export interface ModalButton {
  label: string;
  primary?: boolean;
  /** Return false to keep the modal open (e.g. validation failed). */
  onClick?: (values: Record<string, string>) => boolean | void;
}

export interface ModalField {
  name: string;
  label: string;
  type?: 'text' | 'password';
  value?: string;
  placeholder?: string;
}

export function showModal(options: {
  title: string;
  bodyHTML?: string;
  fields?: ModalField[];
  buttons: ModalButton[];
  /** Extra class on the card (e.g. for wide layouts). */
  cardClass?: string;
}): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const fieldsHTML = (options.fields ?? []).map((f) => `
    <label class="modal-field">
      <span>${f.label}</span>
      <input name="${f.name}" type="${f.type ?? 'text'}" value="${f.value ?? ''}"
        placeholder="${f.placeholder ?? ''}" autocomplete="off" />
    </label>`).join('');
  overlay.innerHTML = `
    <div class="home-card modal-card ${options.cardClass ?? ''}">
      <h2>${options.title}</h2>
      ${options.bodyHTML ?? ''}
      ${fieldsHTML}
      <div class="menu-row modal-buttons"></div>
    </div>`;

  const values = (): Record<string, string> => {
    const out: Record<string, string> = {};
    overlay.querySelectorAll('input[name]').forEach((el) => {
      out[(el as HTMLInputElement).name] = (el as HTMLInputElement).value;
    });
    return out;
  };

  const buttonRow = overlay.querySelector('.modal-buttons')!;
  for (const button of options.buttons) {
    const el = document.createElement('button');
    el.textContent = button.label;
    if (button.primary) el.className = 'primary';
    el.addEventListener('click', () => {
      const keep = button.onClick?.(values());
      if (keep !== false) overlay.remove();
    });
    buttonRow.appendChild(el);
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      (buttonRow.querySelector('button.primary') as HTMLButtonElement | null)?.click();
    }
    if (e.key === 'Escape') overlay.remove();
  });
  document.body.appendChild(overlay);
  (overlay.querySelector('input') as HTMLInputElement | null)?.focus();
  return overlay;
}
