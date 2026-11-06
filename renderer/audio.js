'use strict';
window.GreenAudio = class {
  constructor(audio, canvas) {
    this.audio = audio; this.canvas = canvas; this.synths = new Map(); this.volume = .65; this.synthVolume = .12;
    this.mode = 'hybrid'; this.frame = 0; this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.addEventListener('change', () => this.draw());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.draw(); else cancelAnimationFrame(this.frame); });
    this.resize = new ResizeObserver(() => this.draw()); this.resize.observe(canvas);
    this.draw();
  }
  async ensure() {
    if (!this.context) {
      const context = this.context = new AudioContext();
      this.musicGain = context.createGain(); this.musicGain.gain.value = this.volume;
      this.synthGain = context.createGain(); this.synthGain.gain.value = this.synthVolume;
      this.analyser = context.createAnalyser(); this.analyser.fftSize = 4096; this.analyser.smoothingTimeConstant = .82;
      this.limiter = context.createDynamicsCompressor();
      this.limiter.threshold.value = -6; this.limiter.knee.value = 8; this.limiter.ratio.value = 12;
      context.createMediaElementSource(this.audio).connect(this.musicGain);
      this.musicGain.connect(this.analyser); this.synthGain.connect(this.analyser);
      this.analyser.connect(this.limiter); this.limiter.connect(context.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.context.state !== 'running') await this.context.resume();
  }
  setVolume(volume) { this.volume = volume; if (this.musicGain) this.musicGain.gain.setTargetAtTime(volume, this.context.currentTime, .02); }
  setSynthVolume(volume) { this.synthVolume = volume; if (this.synthGain) this.synthGain.gain.setTargetAtTime(volume, this.context.currentTime, .05); }
  async toggleSynth(frequency) {
    if (!Number.isFinite(frequency) || frequency < 20 || frequency > 2000) return false;
    await this.ensure();
    if (this.synths.has(frequency)) { this.stopSynth(frequency); return false; }
    const context = this.context;
    const gain = context.createGain(); gain.gain.setValueAtTime(0, context.currentTime); gain.gain.linearRampToValueAtTime(.22, context.currentTime + .65);
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = Math.min(5000, frequency * 3.2); filter.Q.value = .6;
    filter.connect(gain); gain.connect(this.synthGain);
    const oscillators = [-4,4].map((detune, index) => {
      const oscillator = context.createOscillator(); oscillator.type = index ? 'sine' : 'triangle';
      oscillator.frequency.value = frequency; oscillator.detune.value = detune;
      oscillator.connect(filter); oscillator.start(); return oscillator;
    });
    const lfo = context.createOscillator(); lfo.frequency.value = .12 + frequency / 8000;
    const depth = context.createGain(); depth.gain.value = .035; lfo.connect(depth); depth.connect(gain.gain); lfo.start();
    this.synths.set(frequency, { oscillators, gain, filter, lfo, depth }); this.draw(); return true;
  }
  stopSynth(frequency) {
    const synth = this.synths.get(frequency); if (!synth) return;
    this.synths.delete(frequency);
    const now = this.context.currentTime;
    synth.gain.gain.cancelScheduledValues(now); synth.gain.gain.setTargetAtTime(0, now, .06);
    for (const node of [...synth.oscillators, synth.lfo]) node.stop(now + .4);
    synth.lfo.onended = () => { for (const node of [...synth.oscillators, synth.lfo, synth.depth, synth.filter, synth.gain]) node.disconnect(); };
    this.draw();
  }
  stopSynths() { for (const frequency of [...this.synths.keys()]) this.stopSynth(frequency); }
  draw() {
    cancelAnimationFrame(this.frame);
    const canvas = this.canvas;
    const width = Math.round(canvas.clientWidth); const height = Math.round(canvas.clientHeight);
    if (!width || !height) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
    const pen = canvas.getContext('2d'); pen.setTransform(ratio,0,0,ratio,0,0); pen.clearRect(0,0,width,height);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || getComputedStyle(document.body).getPropertyValue('--accent').trim();
    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || color;
    pen.strokeStyle = accent; pen.globalAlpha = .09; pen.lineWidth = .5;
    for (let x = 0; x < width; x += 22) { pen.beginPath(); pen.moveTo(x,0); pen.lineTo(x,height); pen.stroke(); }
    for (let y = 0; y < height; y += 18) { pen.beginPath(); pen.moveTo(0,y); pen.lineTo(width,y); pen.stroke(); }
    const active = this.context?.state === 'running' && (!this.audio.paused || this.synths.size > 0);
    if (this.analyser) { this.analyser.getFloatTimeDomainData(this.samples); this.analyser.getByteFrequencyData(this.bins); }
    if (this.mode !== 'bars') {
      const waveHeight = this.mode === 'waves' ? height : height * .66;
      let peak = .01; if (active) for (const sample of this.samples) peak = Math.max(peak, Math.abs(sample));
      const amplitude = Math.min(5, .4 / peak);
      for (let trace = 0; trace < 4; trace++) {
        const baseline = (trace + .5) * waveHeight / 4;
        pen.globalAlpha = [.25,.5,1,.65][trace]; pen.lineWidth = trace === 2 ? 1.4 : .8; pen.shadowBlur = trace === 2 ? 7 : 0; pen.shadowColor = accent;
        pen.beginPath();
        for (let x = 0; x <= width; x++) {
          const index = Math.floor(x / width * 1550) + trace * 280;
          const sample = active ? this.samples[index] : 0;
          const y = baseline + sample * amplitude * waveHeight / 8;
          if (!x) pen.moveTo(x,y); else pen.lineTo(x,y);
        }
        pen.stroke();
      }
    }
    pen.shadowBlur = 0;
    if (this.mode !== 'waves') {
      const base = this.mode === 'bars' ? 0 : height * .74;
      const available = height - base - 4;
      const bands = 96; const step = width / bands;
      const gradient = pen.createLinearGradient(0,base,0,height); gradient.addColorStop(0,accent); gradient.addColorStop(1,accent + '44');
      pen.fillStyle = gradient;
      for (let band = 0; band < bands; band++) {
        const start = Math.max(1, Math.floor(Math.pow(1800, band / bands)));
        const end = Math.max(start + 1, Math.floor(Math.pow(1800, (band + 1) / bands)));
        let energy = 0; if (active) for (let index = start; index < end; index++) energy = Math.max(energy, this.bins[index] || 0);
        const bar = Math.max(1, energy / 255 * available);
        pen.globalAlpha = active ? .95 : .24; pen.fillRect(band * step, height - bar, Math.max(1,step - 1.5), bar);
      }
    }
    pen.globalAlpha = 1;
    if (active && !document.hidden && !this.reducedMotion.matches) this.frame = requestAnimationFrame(() => this.draw());
  }
};
