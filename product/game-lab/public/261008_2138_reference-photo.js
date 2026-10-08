export async function compressPhoto(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15000000) throw new Error('15MB 이하 JPEG, PNG 또는 WebP 사진을 선택해 주세요.');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', .7);
    if (image.length > 550000) throw new Error('사진이 너무 복잡하거나 큽니다. 물체를 가까이 촬영해 주세요.');
    return image;
  } finally { bitmap.close(); }
}

export class ReferencePhoto {
  constructor({ roomId, getIdentity, onExpired, onChange = () => {} }) {
    this.roomId = roomId; this.getIdentity = getIdentity; this.onExpired = onExpired; this.onChange = onChange;
    this.root = document.querySelector('#reference-photo');
    this.image = document.querySelector('#reference-image');
    this.caption = document.querySelector('#reference-caption');
    this.note = document.querySelector('#reference-note');
    this.editor = document.querySelector('#reference-editor');
    this.form = document.querySelector('#reference-form');
    this.label = document.querySelector('#reference-label');
    this.file = document.querySelector('#reference-file');
    this.draftPreview = document.querySelector('#reference-draft');
    this.status = document.querySelector('#reference-status');
    this.save = document.querySelector('#reference-save');
    this.reload = document.querySelector('#reference-reload');
    this.state = null; this.key = null; this.version = 0; this.fileVersion = 0;
    this.reference = null; this.pendingSavedReferenceId = null; this.draft = null; this.loading = false; this.preparing = false; this.saving = false; this.disposed = false;
    this.file.addEventListener('click', () => { this.file.value = ''; });
    this.file.addEventListener('change', () => { if (this.file.files[0]) this.prepare(this.file.files[0]); });
    this.label.addEventListener('input', () => this.controls());
    this.reload.addEventListener('click', () => this.load());
    this.form.addEventListener('submit', event => { event.preventDefault(); this.submit(); });
  }

  canEdit() {
    const state = this.state;
    return !this.disposed && !state?.lab.trackSnapshot && state?.leaderId === this.getIdentity()?.participantId && state.phase === 'started' && state.lab.stage === 'photo';
  }

  context() { return `${this.getIdentity()?.token}:${this.state?.lab.runId}`; }

  update(state, available) {
    if (this.disposed) return;
    const oldContext = this.context();
    this.state = state; this.available = available;
    this.root.hidden = state.track !== 'lab' || state.phase !== 'started' || state.lab.stage !== 'photo';
    if (this.root.hidden) { this.key = null; this.version++; this.loadController?.abort(); this.loading = false; this.clearDraft(); this.editor.hidden = true; this.pendingSavedReferenceId = null; this.status.textContent = ''; return; }
    const metadata = state.lab.reference;
    const saveArrived = this.pendingSavedReferenceId && metadata?.id === this.pendingSavedReferenceId;
    if (saveArrived) this.pendingSavedReferenceId = null;
    if (oldContext !== this.context() || !this.canEdit()) { this.clearDraft(); if (!this.saving && !saveArrived) this.status.textContent = ''; }
    this.editor.hidden = !this.canEdit();
    if (this.editor.hidden) this.editor.open = false;
    const key = JSON.stringify([this.context(), state.lab.config.photoTarget, metadata?.id, metadata?.updatedAt]);
    if (key !== this.key) {
      this.key = key;
      if (!this.draft && !this.preparing) this.label.value = metadata?.label || state.lab.config.photoTarget;
      this.load();
    }
    this.controls();
  }

  controls() {
    const disabled = !this.canEdit() || !this.available || this.saving;
    this.file.disabled = this.label.disabled = disabled;
    this.save.disabled = disabled || this.preparing || !this.draft || !this.label.value.trim();
    this.reload.disabled = !this.available || this.loading;
  }

  clearDraft() {
    this.fileVersion++; this.draft = null; this.preparing = false;
    this.file.value = ''; this.draftPreview.hidden = true; this.draftPreview.removeAttribute('src');
  }

  display(reference) {
    this.reference = reference;
    this.image.hidden = !reference;
    if (reference) { this.image.src = reference.image; this.image.alt = `${reference.label} 기준 사진`; }
    else this.image.removeAttribute('src');
    this.caption.textContent = reference ? reference.label : `${this.state.lab.config.photoTarget} / 기준 사진 없음`;
    this.note.textContent = reference ? '기준 사진의 물체와 같은 물체를 찍어 주세요.' : '등록된 기준 사진이 없어 물체 이름으로 판정합니다.';
    this.onChange(reference);
  }

  async request(method, controller, payload) {
    const response = await fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/reference`, { method, headers: { Authorization: `Bearer ${this.getIdentity().token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || '기준 사진을 불러오지 못했습니다.'), { status: response.status, code: body.code });
    return body.reference;
  }

  async load() {
    const version = ++this.version;
    this.loadController?.abort();
    const controller = new AbortController(); this.loadController = controller;
    this.loading = true; this.controls(); this.image.hidden = true; this.image.removeAttribute('src'); this.reference = null;
    this.caption.textContent = this.state.lab.config.photoTarget; this.note.textContent = '기준 사진을 확인하고 있습니다.'; this.onChange(null);
    try {
      const reference = await this.request('GET', controller);
      if (!this.disposed && version === this.version) this.display(reference);
    } catch (error) {
      if (this.disposed || version !== this.version || error.name === 'AbortError') return;
      if (error.status === 401 || error.code === 'ROOM_IDENTITY_EXPIRED' || error.code === 'ROOM_RESET') { this.onExpired(); return; }
      this.note.textContent = '기준 사진을 불러오지 못했습니다. 기준 사진 다시 확인을 눌러 주세요.';
    } finally { if (version === this.version) { this.loading = false; this.controls(); } }
  }

  async prepare(file) {
    if (!this.canEdit()) return;
    const version = ++this.fileVersion, context = this.context();
    this.preparing = true; this.status.textContent = '기준 사진을 준비하고 있습니다.'; this.controls();
    try {
      const image = await compressPhoto(file);
      if (this.disposed || version !== this.fileVersion || context !== this.context() || !this.canEdit()) return;
      this.draft = image; this.draftPreview.src = image; this.draftPreview.hidden = false;
      this.status.textContent = '물체 이름과 사진을 확인하고 저장해 주세요.';
    } catch (error) { if (version === this.fileVersion && !this.disposed) this.status.textContent = error.message || '사진을 읽지 못했습니다.'; }
    finally { if (version === this.fileVersion) { this.preparing = false; this.controls(); } }
  }

  async submit() {
    if (this.save.disabled || !this.canEdit()) return;
    const context = this.context(), label = this.label.value.trim();
    const actorId = this.getIdentity()?.participantId, token = this.getIdentity()?.token;
    this.saving = true; this.status.textContent = '팀의 기준 사진을 저장하고 있습니다.'; this.controls();
    const controller = new AbortController(); this.saveController = controller;
    try {
      const reference = await this.request('POST', controller, { image: this.draft, label, runId: this.state.lab.runId });
      const sameActor = actorId === this.getIdentity()?.participantId && token === this.getIdentity()?.token;
      const samePhoto = this.state?.phase === 'started' && this.state.lab.stage === 'photo';
      const returnedCurrent = reference?.id && reference.id === this.state?.lab.reference?.id;
      if (this.disposed || !sameActor || !samePhoto || context !== this.context() && !returnedCurrent) return;
      this.pendingSavedReferenceId = returnedCurrent ? null : reference?.id;
      this.clearDraft(); this.status.textContent = '팀의 기준 사진을 저장했습니다. 전원의 사진 테스트를 다시 시작합니다.';
      this.load();
    } catch (error) {
      if (this.disposed || context !== this.context() || error.name === 'AbortError') return;
      if (error.status === 401 || error.code === 'ROOM_IDENTITY_EXPIRED' || error.code === 'ROOM_RESET') { this.onExpired(); return; }
      this.status.textContent = error.message || '기준 사진을 저장하지 못했습니다.';
    } finally { if (!this.disposed && this.saveController === controller) { this.saving = false; if (this.status.textContent === '팀의 기준 사진을 저장하고 있습니다.') this.status.textContent = ''; this.controls(); } }
  }

  dispose() {
    this.disposed = true; this.version++; this.clearDraft(); this.loadController?.abort(); this.saveController?.abort();
    this.image.hidden = true; this.image.removeAttribute('src'); this.reference = null;
  }
}
