/**
 * Cola unificada de subidas / recargas.
 * - pause / resume / retry
 * - estimación de tiempo (media de jobs completados)
 * - persistencia de estado (no de File handles: al recargar quedan como "interrupted")
 */
export function createJobQueue({ el, pref }) {
  const STORE = 'jobQueue:v1';
  const STATS = 'jobQueue:stats';
  let jobs = [];
  let running = false;
  let paused = false;
  let listeners = new Set();
  let currentAbort = null;

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || '[]');
      jobs = Array.isArray(raw) ? raw.map((j) => {
        // No se puede reanudar File: marcar pending/running sin runner como interrupted
        if (j.status === 'running' || (j.status === 'pending' && !j._ephemeral)) {
          if (j.status === 'running') j.status = 'interrupted';
        }
        return j;
      }) : [];
    } catch {
      jobs = [];
    }
  }

  function save() {
    try {
      const slim = jobs.map(({ _run, ...rest }) => rest);
      localStorage.setItem(STORE, JSON.stringify(slim.slice(-40)));
    } catch (_) {}
  }

  function emit() {
    for (const fn of listeners) {
      try { fn(getState()); } catch (_) {}
    }
    save();
    paintPanel();
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function getState() {
    return {
      jobs: jobs.map(({ _run, ...j }) => j),
      paused,
      running,
    };
  }

  function avgMsPerJob() {
    try {
      const s = JSON.parse(localStorage.getItem(STATS) || '{}');
      const n = s.count || 0;
      const t = s.totalMs || 0;
      if (n > 0) return t / n;
    } catch (_) {}
    return 0;
  }

  function recordDuration(ms) {
    try {
      const s = JSON.parse(localStorage.getItem(STATS) || '{}');
      s.count = (s.count || 0) + 1;
      s.totalMs = (s.totalMs || 0) + ms;
      localStorage.setItem(STATS, JSON.stringify(s));
    } catch (_) {}
  }

  function etaLabel() {
    const pending = jobs.filter((j) => j.status === 'pending' || j.status === 'running' || j.status === 'paused');
    const avg = avgMsPerJob();
    if (!pending.length || !avg) return '';
    const ms = avg * pending.length;
    if (ms < 60000) return `~${Math.round(ms / 1000)} s restantes`;
    return `~${Math.round(ms / 60000)} min restantes`;
  }

  function enqueue(job) {
    const id = job.id || (`job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const row = {
      id,
      type: job.type || 'job',
      label: job.label || id,
      status: 'pending',
      attempts: 0,
      maxAttempts: job.maxAttempts || 3,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      progress: 0,
      log: [],
      _run: job.run,
      _ephemeral: true,
    };
    jobs.push(row);
    emit();
    pump();
    return id;
  }

  function pause() {
    paused = true;
    emit();
  }

  function resume() {
    paused = false;
    emit();
    pump();
  }

  function retry(id) {
    const j = jobs.find((x) => x.id === id);
    if (!j) return;
    if (typeof j._run !== 'function') {
      // No se puede reintentar sin el File en memoria: eliminar de la cola
      jobs = jobs.filter((x) => x.id !== id);
      emit();
      alert('Ese trabajo ya no se puede reintentar (se perdió al recargar). Vuelve a Subir / Recargar el archivo.');
      return;
    }
    j.status = 'pending';
    j.error = null;
    j.progress = 0;
    emit();
    pump();
  }

  function remove(id) {
    jobs = jobs.filter((x) => x.id !== id);
    emit();
  }

  function failedJobs() {
    return jobs.filter((j) => j.status === 'error' || j.status === 'interrupted');
  }

  async function pump() {
    if (running || paused) return;
    const next = jobs.find((j) => j.status === 'pending' && typeof j._run === 'function');
    if (!next) return;
    running = true;
    next.status = 'running';
    next.startedAt = Date.now();
    next.attempts = (next.attempts || 0) + 1;
    emit();

    const ctx = {
      log: (line) => {
        next.log = (next.log || []).slice(-200);
        next.log.push(String(line));
        appendLogLine(next.id, line);
        save();
      },
      setProgress: (p) => {
        next.progress = Math.max(0, Math.min(100, Number(p) || 0));
        setBar(next.progress);
        save();
      },
      isPaused: () => paused,
      waitWhilePaused: async () => {
        while (paused) await new Promise((r) => setTimeout(r, 200));
      },
      isAborted: () => next.status === 'cancelled',
    };

    try {
      await next._run(ctx);
      if (next.status === 'cancelled') {
        /* keep */
      } else {
        next.status = 'done';
        next.progress = 100;
        next.finishedAt = Date.now();
        if (next.startedAt) recordDuration(next.finishedAt - next.startedAt);
      }
    } catch (e) {
      next.error = e?.message || String(e);
      if (next.attempts < next.maxAttempts && typeof next._run === 'function') {
        next.status = 'pending';
        ctx.log(`Reintento ${next.attempts}/${next.maxAttempts}: ${next.error}`);
      } else {
        next.status = 'error';
        next.finishedAt = Date.now();
      }
    }
    running = false;
    emit();
    pump();
  }

  // ---- UI panel ----
  function ensurePanel() {
    let panel = document.getElementById('job-queue-panel');
    if (panel) return panel;
    panel = el('div', 'repack-panel');
    panel.id = 'job-queue-panel';
    const head = el('div', 'repack-panel-head');
    head.append(el('div', 'repack-panel-title', 'Cola de tareas'));
    const btnMin = el('button', 'btn repack-min', 'Ocultar');
    btnMin.type = 'button';
    btnMin.onclick = () => {
      panel.hidden = true;
      const chip = ensureChip();
      chip.hidden = false;
    };
    head.append(btnMin);
    const bar = el('div', 'repack-panel-bar');
    const fill = el('div', 'repack-panel-fill');
    fill.id = 'job-queue-fill';
    bar.append(fill);
    const eta = el('div', 'job-queue-eta');
    eta.id = 'job-queue-eta';
    const list = el('div', 'repack-panel-log');
    list.id = 'job-queue-list';
    const log = el('div', 'repack-panel-log');
    log.id = 'job-queue-log';
    log.style.maxHeight = '120px';
    const actions = el('div', 'repack-panel-actions');
    const btnPause = el('button', 'btn', 'Pausar');
    btnPause.id = 'job-queue-pause';
    btnPause.type = 'button';
    btnPause.onclick = () => {
      if (paused) resume();
      else pause();
      btnPause.textContent = paused ? 'Reanudar' : 'Pausar';
    };
    const btnClear = el('button', 'btn', 'Limpiar fallos');
    btnClear.type = 'button';
    btnClear.onclick = () => clearFailed();
    const btnClose = el('button', 'btn', 'Cerrar');
    btnClose.type = 'button';
    btnClose.onclick = () => { panel.hidden = true; };
    actions.append(btnPause, btnClear, btnClose);
    panel.append(head, bar, eta, list, log, actions);
    document.body.append(panel);
    return panel;
  }

  function ensureChip() {
    let chip = document.getElementById('job-queue-chip');
    if (chip) return chip;
    chip = el('button', 'repack-chip', 'Cola');
    chip.id = 'job-queue-chip';
    chip.type = 'button';
    chip.onclick = () => {
      const panel = ensurePanel();
      panel.hidden = false;
      chip.hidden = true;
      paintPanel();
    };
    document.body.append(chip);
    return chip;
  }

  function appendLogLine(jobId, line) {
    const log = document.getElementById('job-queue-log');
    if (!log) return;
    const row = el('div', 'repack-log-line', line);
    log.append(row);
    log.scrollTop = log.scrollHeight;
  }

  function setBar(pct) {
    const fill = document.getElementById('job-queue-fill');
    if (fill) fill.style.width = `${pct}%`;
  }

  function paintPanel() {
    const panel = document.getElementById('job-queue-panel');
    if (!panel || panel.hidden) {
      const active = jobs.some((j) => j.status === 'pending' || j.status === 'running');
      if (active) {
        const chip = ensureChip();
        if (!document.getElementById('job-queue-panel') || document.getElementById('job-queue-panel').hidden) {
          chip.hidden = false;
          chip.textContent = `Cola (${jobs.filter((j) => j.status === 'pending' || j.status === 'running').length})`;
        }
      }
      return;
    }
    const list = document.getElementById('job-queue-list');
    const eta = document.getElementById('job-queue-eta');
    const btnPause = document.getElementById('job-queue-pause');
    if (btnPause) btnPause.textContent = paused ? 'Reanudar' : 'Pausar';
    if (eta) eta.textContent = etaLabel() || (paused ? 'En pausa' : '');
    if (!list) return;
    list.replaceChildren();
    for (const j of jobs.slice(-15).reverse()) {
      const row = el('div', 'repack-log-line');
      const st = j.status;
      row.textContent = `[${st}] ${j.label}${j.error ? ' — ' + j.error : ''}`;
      if (st === 'error' || st === 'interrupted') {
        const rt = el('button', 'btn repack-min', 'Reintentar');
        rt.type = 'button';
        rt.style.marginLeft = '8px';
        rt.onclick = () => retry(j.id);
        row.append(rt);
      }
      list.append(row);
    }
  }

  function show() {
    const panel = ensurePanel();
    panel.hidden = false;
    const chip = document.getElementById('job-queue-chip');
    if (chip) chip.hidden = true;
    paintPanel();
  }

  load();
  // Mark orphaned running as interrupted; quitar zombies irrecuperables
  jobs = jobs.filter((j) => {
    if (j.status === 'running') j.status = 'interrupted';
    // Errores viejos de código (asWebp) o interrupted sin runner: no sirven
    if (j.status === 'error' && /asWebp/i.test(String(j.error || ''))) return false;
    return true;
  });
  for (const j of jobs) {
    if (j.status === 'running') j.status = 'interrupted';
  }
  save();

  function clearFailed() {
    jobs = jobs.filter((x) => x.status !== 'error' && x.status !== 'interrupted');
    emit();
  }

  return {
    enqueue,
    pause,
    resume,
    retry,
    remove,
    clearFailed,
    failedJobs,
    getState,
    onChange,
    show,
    etaLabel,
    avgMsPerJob,
  };
}
