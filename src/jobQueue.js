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
        const text = String(line);
        next.log = next.log || [];
        // Actualizar última línea si es el mismo progreso (… 12%) en vez de spamear
        const stripPct = (s) => String(s).replace(/\s*\d{1,3}\s*%\s*$/, '').trim();
        const isPct = /\d{1,3}\s*%\s*$/.test(text);
        if (isPct && next.log.length) {
          const last = next.log[next.log.length - 1];
          if (stripPct(last) === stripPct(text)) {
            next.log[next.log.length - 1] = text;
            appendLogLine(next.id, text, true);
            save();
            return;
          }
        }
        next.log.push(text);
        if (next.log.length > 200) next.log = next.log.slice(-200);
        appendLogLine(next.id, text, false);
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
    panel = el('div', 'repack-panel job-queue-panel');
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

    // Sección 1: trabajo actual (desplegable)
    const curFold = el('details', 'job-fold');
    curFold.open = true;
    curFold.id = 'job-fold-current';
    const curSum = el('summary', '', 'Trabajo actual');
    curFold.append(curSum);
    const curBody = el('div', 'job-fold-body');
    const curStatus = el('div', 'job-current-status');
    curStatus.id = 'job-current-status';
    curStatus.textContent = 'Ninguno';
    const log = el('div', 'repack-panel-log job-fold-scroll');
    log.id = 'job-queue-log';
    curBody.append(curStatus, log);
    curFold.append(curBody);

    // Sección 2: pendientes / historial
    const pendFold = el('details', 'job-fold');
    pendFold.open = true;
    pendFold.id = 'job-fold-pending';
    const pendSum = el('summary', '', 'Tareas pendientes e historial');
    pendFold.append(pendSum);
    const pendBody = el('div', 'job-fold-body');
    const list = el('div', 'repack-panel-log job-fold-scroll');
    list.id = 'job-queue-list';
    pendBody.append(list);
    pendFold.append(pendBody);

    const actions = el('div', 'repack-panel-actions job-queue-actions');
    const btnPause = el('button', 'btn', 'Pausar');
    btnPause.id = 'job-queue-pause';
    btnPause.type = 'button';
    btnPause.onclick = () => {
      if (paused) resume();
      else pause();
      btnPause.textContent = paused ? 'Reanudar' : 'Pausar';
    };
    const btnClear = el('button', 'btn', 'Limpiar completados');
    btnClear.id = 'job-queue-clear';
    btnClear.type = 'button';
    btnClear.onclick = () => clearSmart();
    const btnClose = el('button', 'btn', 'Cerrar');
    btnClose.type = 'button';
    btnClose.onclick = () => { panel.hidden = true; };
    actions.append(btnPause, btnClear, btnClose);

    panel.append(head, bar, eta, curFold, pendFold, actions);
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

  function appendLogLine(jobId, line, replaceLast = false) {
    const log = document.getElementById('job-queue-log');
    if (!log) return;
    if (replaceLast && log.lastElementChild) {
      log.lastElementChild.textContent = line;
      log.scrollTop = log.scrollHeight;
      return;
    }
    const row = el('div', 'repack-log-line', line);
    log.append(row);
    log.scrollTop = log.scrollHeight;
  }

  function setBar(pct) {
    const fill = document.getElementById('job-queue-fill');
    if (fill) fill.style.width = `${pct}%`;
  }

  function isReaderOpen() {
    return !!document.getElementById('rd');
  }

  function hideQueueUi() {
    const panel = document.getElementById('job-queue-panel');
    const chip = document.getElementById('job-queue-chip');
    if (panel) panel.hidden = true;
    if (chip) chip.hidden = true;
  }

  function paintPanel() {
    // Nunca mostrar basura sobre el lector de cómics
    if (isReaderOpen()) {
      hideQueueUi();
      return;
    }
    const panel = document.getElementById('job-queue-panel');
    if (!panel || panel.hidden) {
      const active = jobs.some((x) => x.status === 'pending' || x.status === 'running');
      if (active) {
        const chip = ensureChip();
        if (!document.getElementById('job-queue-panel') || document.getElementById('job-queue-panel').hidden) {
          chip.hidden = false;
          const n = jobs.filter((x) => x.status === 'pending' || x.status === 'running').length;
          chip.textContent = n > 1 ? ('Cola (' + n + ')') : 'Cola';
        }
      }
      return;
    }
    const list = document.getElementById('job-queue-list');
    const eta = document.getElementById('job-queue-eta');
    const btnPause = document.getElementById('job-queue-pause');
    const btnClear = document.getElementById('job-queue-clear');
    const curStatus = document.getElementById('job-current-status');
    if (btnPause) btnPause.textContent = paused ? 'Reanudar' : 'Pausar';
    if (btnClear) {
      const hasDone = jobs.some((x) => x.status === 'done');
      const hasFail = jobs.some((x) => x.status === 'error' || x.status === 'interrupted');
      if (hasDone) {
        btnClear.hidden = false;
        btnClear.textContent = 'Limpiar completados';
      } else if (hasFail) {
        btnClear.hidden = false;
        btnClear.textContent = 'Limpiar fallos';
      } else {
        btnClear.hidden = true;
      }
    }
    if (eta) eta.textContent = etaLabel() || (paused ? 'En pausa' : '');

    const running = jobs.find((x) => x.status === 'running');
    if (curStatus) {
      if (running) {
        curStatus.textContent = running.label + ' · ' + Math.round(running.progress || 0) + '%';
      } else if (paused) {
        curStatus.textContent = 'En pausa';
      } else {
        const next = jobs.find((x) => x.status === 'pending');
        curStatus.textContent = next ? ('Siguiente: ' + next.label) : 'Ninguno';
      }
    }

    // Rellenar barra con progreso del running
    if (running) setBar(running.progress || 0);

    if (!list) return;
    list.replaceChildren();
    const ordered = jobs.slice(-20).reverse();
    for (const job of ordered) {
      const row = el('div', 'job-row');
      const st = job.status;
      const label = el('span', 'job-row-label');
      label.textContent = '[' + st + '] ' + job.label + (job.error ? ' — ' + job.error : '');
      row.append(label);
      if (st === 'error' || st === 'interrupted') {
        const rt = el('button', 'btn repack-min', 'Reintentar');
        rt.type = 'button';
        rt.onclick = () => retry(job.id);
        const rm = el('button', 'btn repack-min', 'Quitar');
        rm.type = 'button';
        rm.onclick = () => remove(job.id);
        row.append(rt, rm);
      } else if (st === 'pending') {
        const rm = el('button', 'btn repack-min', 'Quitar');
        rm.type = 'button';
        rm.onclick = () => remove(job.id);
        row.append(rm);
      } else if (st === 'done') {
        const rm = el('button', 'btn repack-min', 'Quitar');
        rm.type = 'button';
        rm.onclick = () => remove(job.id);
        row.append(rm);
      }
      list.append(row);
    }
  }

  function show() {
    if (isReaderOpen()) return; // no molestar en el visor
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

  function clearDone() {
    jobs = jobs.filter((x) => x.status !== 'done');
    emit();
  }

  /** Prioridad: limpiar completados; si no hay, limpiar fallos */
  function clearSmart() {
    const hasDone = jobs.some((x) => x.status === 'done');
    if (hasDone) clearDone();
    else clearFailed();
  }

  try {
    window.addEventListener('tgcomic:reader', (ev) => {
      if (ev?.detail?.open) hideQueueUi();
      else paintPanel();
    });
  } catch (_) {}

  return {
    enqueue,
    pause,
    resume,
    retry,
    remove,
    clearFailed,
    clearDone,
    clearSmart,
    failedJobs,
    getState,
    onChange,
    show,
    hideQueueUi,
    etaLabel,
    avgMsPerJob,
  };
}
