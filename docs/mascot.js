(() => {
  const assetRoot = new URL('./mascot/', document.currentScript.src);
  const host = document.createElement('aside');
  host.className = 'mascot';
  host.setAttribute('aria-label', '互动看板娘');
  host.innerHTML = `
    <button class="mascot-puppet" type="button" aria-label="互动看板娘">
      <svg viewBox="0 0 1254 1254" aria-hidden="true">
        <defs>
          <mask id="mascot-base-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><path d="M0 229Q35 207 55 227Q68 191 115 173Q180 154 188 181Q193 190 202 166Q244 124 312 130Q379 130 384 154Q390 168 412 163Q429 134 476 144Q543 145 561 184Q577 205 595 188Q615 175 657 195Q716 216 739 250Q743 280 764 274Q785 264 822 291Q873 329 886 371Q890 392 879 401Q872 413 896 420Q917 411 941 447Q974 497 982 533Q987 558 962 575Q975 571 993 602Q1028 655 1021 698Q1016 725 998 736C1064 835 1125 1057 1216 1095Q1174 1130 1114 1111Q1090 1120 1083 1112L1147 1254H0Z" fill="white" stroke="black" stroke-width="10" stroke-linejoin="round"/></mask>
          <clipPath id="mascot-ear-clip"><path d="M952 735L996 731C1064 835 1125 1057 1216 1095Q1174 1130 1114 1111Q1090 1120 1083 1112Q998 1112 968 1010Z"/></clipPath>
          <mask id="mascot-head-only" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><rect width="1254" height="1254" fill="white"/><path d="M980 735L996 731C1064 835 1125 1057 1216 1095Q1174 1130 1114 1111Q1090 1120 1083 1112Q998 1112 990 1010Z" fill="black"/></mask>
          <linearGradient id="mascot-eye" x2="1" y2="1"><stop stop-color="#141a32"/><stop offset="1" stop-color="#242b49"/></linearGradient>
        </defs>
        <g data-part="head">
          <g data-part="ear">
          <image href="${assetRoot}base.png" width="1254" height="1254" mask="url(#mascot-base-mask)" clip-path="url(#mascot-ear-clip)"/>
          </g>
          <g mask="url(#mascot-head-only)">
          <image href="${assetRoot}base.png" width="1254" height="1254" mask="url(#mascot-base-mask)"/>
          </g>
          <g data-part="tuft"><image href="${assetRoot}tuft.svg" width="1254" height="1254"/></g>
          <g data-part="bow"><image href="${assetRoot}bow.svg" width="1254" height="1254"/></g>
          <g data-part="gaze">
            <g transform="translate(206 760) rotate(18)"><g data-part="eye-left"><ellipse rx="61" ry="107" fill="url(#mascot-eye)"/><ellipse cx="-17" cy="-42" rx="10" ry="15" fill="white" opacity=".65"/></g><path data-part="lid-left" d="M-53 10Q0 -33 53 10" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
            <g transform="translate(631 908) rotate(18)"><g data-part="eye-right"><ellipse rx="57" ry="103" fill="url(#mascot-eye)"/><ellipse cx="-17" cy="-42" rx="9" ry="14" fill="white" opacity=".65"/></g><path data-part="lid-right" d="M-50 10Q0 -32 50 10" fill="none" stroke="#222940" stroke-width="13" stroke-linecap="round" opacity="0"/></g>
          </g>
          <g data-part="blush" opacity="0" fill="#f493ac"><ellipse cx="57" cy="892" rx="74" ry="36" transform="rotate(20 57 892)"/><ellipse cx="683" cy="1074" rx="68" ry="36" transform="rotate(20 683 1074)"/></g>
        </g>
      </svg>
    </button>`;
  document.body.append(host);
  const button = host.querySelector('button');
  const parts = Object.fromEntries([...host.querySelectorAll('[data-part]')].map(el => [el.dataset.part, el]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let failed = false;
  let frame = 0, last = 0, clock = 0, nextBlink = 2 + Math.random() * 3;
  let blinkStart = -10, bounce = 0;
  let targetX = 0, targetY = 0, x = 0, y = 0, tuft = 0, velocity = 0, bow = 0, bowVelocity = 0;
  // Original fish rig, with independently sprung pose and expression channels.
  const springs = Object.fromEntries(Object.entries({ tilt: 0, lift: 0, squash: 1, left: 1, right: 1, smile: 0, ear: 0 })
    .map(([key, value]) => [key, { value, velocity: 0 }]));
  const playlist = ['curious', 'idle', 'thinking', 'idle', 'playful', 'idle', 'drowsy', 'sleeping', 'waking', 'idle'];
  let state = 'curious', stateAt = 0, stateUntil = 3.2, sequence = 0, hovering = false;
  function setState(next, duration) {
    state = next; stateAt = clock; stateUntil = clock + duration;
    host.dataset.state = next;
  }
  function spring(key, target, dt) {
    const channel = springs[key];
    // Substeps keep the damped oscillator stable on slower displays.
    const steps = Math.ceil(dt / .008), step = dt / steps;
    for (let i = 0; i < steps; i++) {
      channel.velocity += ((target - channel.value) * 110 - channel.velocity * 14) * step;
      channel.value += channel.velocity * step;
    }
    return channel.value;
  }
  host.dataset.state = state;
  let rect = host.getBoundingClientRect();
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const active = () => !failed && !reduced.matches && !document.hidden;
  const refreshRect = () => { rect = host.getBoundingClientRect(); };
  new ResizeObserver(refreshRect).observe(host);
  window.addEventListener('resize', refreshRect);
  function neutral() {
    for (const name of ['head','tuft','bow','ear','gaze','eye-left','eye-right']) parts[name].removeAttribute('transform');
    for (const name of ['lid-left','lid-right','blush']) parts[name].setAttribute('opacity','0');
  }
  function sync() {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    document.documentElement.classList.toggle('background-paused', !active());
    if (active()) frame = requestAnimationFrame(tick);
    else { neutral(); relax(); }
  }
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pointermove', event => {
    if (!active() || event.pointerType === 'touch') return;
    targetX = clamp((event.clientX - rect.left - rect.width * .4) / (innerWidth * .55), -1, 1);
    targetY = clamp((event.clientY - rect.top - rect.height * .62) / (innerHeight * .55), -1, 1);
  }, { passive: true });
  const relax = () => { targetX = 0; targetY = 0; };
  document.documentElement.addEventListener('pointerleave', relax);
  window.addEventListener('blur', relax);
  button.addEventListener('pointerenter', () => {
    if (!active()) return;
    hovering = true;
    setState(state === 'sleeping' || state === 'drowsy' ? 'waking' : 'curious', 1.8);
  });
  button.addEventListener('pointerleave', () => { hovering = false; });
  let lastPet = -10;
  button.addEventListener('pointermove', event => {
    if (!active() || clock - lastPet < .3) return;
    const py = (event.clientY - rect.top) / rect.height;
    if (py < .45) { velocity += clamp(event.movementX || 0, -15, 15) * 2; lastPet = clock; }
  }, { passive: true });
  button.addEventListener('click', event => {
    if (!active()) return;
    const px = event.detail ? (event.clientX - rect.left) / rect.width : .4;
    const py = event.detail ? (event.clientY - rect.top) / rect.height : .4;
    bounce = 1; springs.ear.velocity += 28; setState('happy', 1.5);
    if (py < .3) velocity += 145;
    else if (px > .73) bowVelocity += 155;
    else { velocity += 75; bowVelocity += 65; }
    velocity = clamp(velocity,-180,180); bowVelocity = clamp(bowVelocity,-180,180);
  });
  function tick(now) {
    if (!active()) { frame = 0; return; }
    const dt = last ? Math.min((now - last) / 1000, .035) : 1 / 60;
    last = now; clock += dt;
    const ease = 1 - Math.exp(-dt * 7);
    x += (targetX - x) * ease; y += (targetY - y) * ease;
    const tuftTarget = x * 7 + Math.sin(clock * 2.3) * 2;
    velocity += ((tuftTarget - tuft) * 65 - velocity * 9) * dt; tuft += velocity * dt;
    const bowTarget = -x * 5 + Math.sin(clock * 2.7 + 1) * 2.5;
    bowVelocity += ((bowTarget - bow) * 75 - bowVelocity * 10) * dt; bow += bowVelocity * dt;
    if (clock >= stateUntil) {
      if (hovering) setState('curious', 2.4);
      else { sequence = (sequence + 1) % playlist.length; setState(playlist[sequence], playlist[sequence] === 'sleeping' ? 4 : 3.2); }
    }
    const age = clock - stateAt;
    let tilt = Math.sin(clock * .8) * 1.2, lift = Math.sin(clock * 1.6) * 4;
    let squash = 1, left = 1, right = 1, smile = 0;
    let lookX = x, lookY = y;
    switch (state) {
      case 'curious': tilt += 6; lift -= 9; left = 1.08; right = .82; break;
      case 'thinking': tilt -= 5; left = .65; right = .85; lookY -= .6; lookX += .35; break;
      case 'playful': tilt += Math.sin(age * 4) * 5; lift -= Math.abs(Math.sin(age * 3)) * 22; squash += Math.sin(age * 6) * .018; break;
      case 'drowsy': tilt += 4; lift += 10; left = right = .45; break;
      case 'sleeping': tilt += 6; lift += 16; left = right = .055; squash += Math.sin(age * 2) * .012; lookX = lookY = 0; break;
      case 'waking': lift -= 16 * Math.sin(Math.min(age / 1.8, 1) * Math.PI); left = right = 1.12; break;
      case 'happy': tilt += Math.sin(age * 9) * 3; lift -= Math.abs(Math.sin(age * 7)) * 20; squash += Math.sin(age * 10) * .025; smile = 1; break;
    }
    tilt = spring('tilt', tilt, dt);
    lift = spring('lift', lift, dt);
    squash = spring('squash', squash, dt);
    left = spring('left', left, dt); right = spring('right', right, dt);
    smile = clamp(spring('smile', smile, dt), 0, 1);
    bounce *= Math.exp(-dt * 4);
    const angle = tilt + x * 2.4;
    const radians = angle * Math.PI / 180;
    const limit = (-host.offsetLeft - 3) * 1254 / (host.clientWidth || 1254);
    const edgeX = edgeY => 460 + Math.cos(radians) * (6 - 460) / squash - Math.sin(radians) * (edgeY - 1080) * squash;
    const shiftX = Math.min(x * 8, limit - Math.max(edgeX(229), edgeX(1254)));
    parts.head.setAttribute('transform', `translate(${shiftX} ${lift + y * 5 - bounce * 18}) rotate(${angle} 460 1080) translate(460 1080) scale(${1 / squash} ${squash}) translate(-460 -1080)`);
    parts.tuft.setAttribute('transform', `rotate(${tuft} 472 272)`);
    parts.ear.setAttribute('transform', `rotate(${spring('ear', -x * 2 + Math.sin(clock * 1.9) * 1.2 - bow * .22, dt)} 969 790)`);
    parts.bow.setAttribute('transform', `rotate(${bow} 1022 818)`);
    parts.gaze.setAttribute('transform', `translate(${clamp(lookX, -1, 1) * 24} ${clamp(lookY, -1, 1) * 17})`);
    if (clock >= nextBlink) { blinkStart = clock; nextBlink = clock + 2.6 + Math.random() * 4; }
    const blinkAge = clock - blinkStart;
    const blink = blinkAge < .19 ? 1 - Math.sin(blinkAge / .19 * Math.PI) * .97 : 1;
    for (const side of ['left','right']) {
      parts[`eye-${side}`].setAttribute('transform', `scale(1 ${Math.max(.025, (side === 'left' ? left : right) * blink * (1 - smile))})`);
      parts[`lid-${side}`].setAttribute('opacity', String(smile));
    }
    parts.blush.setAttribute('opacity', String(smile * .42));
    frame = requestAnimationFrame(tick);
  }
  // If the layer fails to load, keep the original illustration instead of a partial face.
  const base = new Image();
  base.onerror = () => { failed = true; sync(); host.remove(); const fb = document.querySelector('.backdrop-character'); if (fb) fb.style.display = 'block'; };
  base.src = new URL('base.png', assetRoot).href;
  sync();
})();
