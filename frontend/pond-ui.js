(function () {
  'use strict';

  function required(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing pond interface element: #${id}`);
    return element;
  }

  function plural(value, singular, pluralForm) {
    return `${value} ${value === 1 ? singular : (pluralForm || `${singular}s`)}`;
  }

  function poeticDuration(milliseconds) {
    const minutes = Math.max(1, Math.floor(milliseconds / 60000));
    if (minutes < 60) return plural(minutes, 'minute');
    const hours = Math.floor(minutes / 60);
    if (hours < 36) return plural(hours, 'hour');
    return plural(Math.floor(hours / 24), 'day');
  }

  class PondUI {
    constructor(options) {
      const config = options || {};
      this.presence = required('presence');
      this.soundButton = required('sound-button');
      this.cameraButton = required('camera-button');
      this.ledgerButton = required('ledger-button');
      this.ledgerClose = required('ledger-close');
      this.ledger = required('ledger');
      this.labels = required('labels');
      this.birthCue = required('birth-cue');
      this.queueState = required('queue-state');
      this.notice = required('pond-notice');
      this.connectionState = required('connection-state');
      this.offeringMenu = required('offering-menu');
      this.ledgerName = required('ledger-name');
      this.ledgerLineage = required('ledger-lineage');
      this.ledgerSouls = required('ledger-souls');
      this.ledgerAge = required('ledger-age');
      this.ledgerRipples = required('ledger-ripples');
      this.ledgerCapacity = required('ledger-capacity');
      this.memoryList = required('memory-list');
      this.reducedMotionInput = required('reduced-motion');
      this.largerLabelsInput = required('larger-labels');
      this.labelElements = new Map();
      this.offeringPoint = null;
      this.identity = null;
      this.pondBornAt = Date.now();
      this.awakened = false;
      this.noticeTimer = null;
      this.onSoundToggle = null;
      this.onCameraToggle = null;
      this.onReducedMotion = null;
      this.onOffering = null;

      this.reducedMotionInput.checked = !!config.reducedMotion;
      this.soundButton.addEventListener('click', () => {
        this.awaken();
        if (this.onSoundToggle) this.onSoundToggle();
      });
      this.cameraButton.addEventListener('click', () => {
        this.awaken();
        if (this.onCameraToggle) this.onCameraToggle();
      });
      this.ledgerButton.addEventListener('click', () => this.openLedger());
      this.ledgerClose.addEventListener('click', () => this.closeLedger());
      this.reducedMotionInput.addEventListener('change', () => {
        if (this.onReducedMotion) this.onReducedMotion(this.reducedMotionInput.checked);
      });
      this.largerLabelsInput.addEventListener('change', () => {
        this.labels.classList.toggle('is-large', this.largerLabelsInput.checked);
      });
      for (const button of this.offeringMenu.querySelectorAll('[data-offering]')) {
        button.addEventListener('click', () => {
          if (!this.offeringPoint || !this.onOffering) return;
          this.onOffering(button.dataset.offering, this.offeringPoint);
          this.hideOfferingMenu();
        });
      }
      addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        this.hideOfferingMenu();
        this.closeLedger();
      });
    }

    awaken() {
      if (this.awakened) return;
      this.awakened = true;
      this.ledgerButton.hidden = false;
      document.documentElement.classList.add('pond-awake');
    }

    setSoundEnabled(enabled) {
      this.soundButton.classList.toggle('is-muted', !enabled);
      this.soundButton.setAttribute('aria-label', enabled ? 'Turn pond sound off' : 'Turn pond sound on');
    }

    setCameraAvailable(available) {
      this.cameraButton.hidden = !available;
    }

    setCameraMode(mode) {
      const riding = mode === 'ride';
      this.cameraButton.classList.toggle('is-riding', riding);
      this.cameraButton.setAttribute('aria-label', riding ? 'Return to pond overview' : 'Ride your fish');
      this.cameraButton.title = riding ? 'Pond overview' : 'Ride your fish';
    }

    setConnection(state) {
      this.connectionState.classList.toggle('is-ready', state === 'open');
      this.connectionState.textContent = state === 'open'
        ? 'shared water reached'
        : state === 'closed'
          ? 'the shared water is out of reach'
          : 'reaching the shared water';
    }

    setIdentity(identity) {
      this.identity = identity;
      this.ledgerName.textContent = identity.name;
      this.ledgerLineage.textContent = identity.completedLives === 0
        ? 'no completed lives'
        : plural(identity.completedLives, 'completed life', 'completed lives');
    }

    setSnapshot(snapshot) {
      this.pondBornAt = snapshot.pondBornAt;
      this.updatePresence(snapshot.connectedSouls, snapshot.capacity);
      this.ledgerRipples.textContent = Number(snapshot.foundingRipples || 0).toLocaleString();
      this.ledgerAge.textContent = poeticDuration(snapshot.serverTime - snapshot.pondBornAt);
      this.updateMemories(snapshot.memories || []);
    }

    updatePresence(connectedSouls, capacity) {
      this.presence.textContent = connectedSouls === 1
        ? '1 soul in the pond'
        : `${connectedSouls} souls in the pond`;
      this.ledgerSouls.textContent = plural(connectedSouls, 'live soul');
      this.ledgerCapacity.textContent = capacity.queued > 0
        ? `${plural(capacity.embodied, 'life')} in water, ${plural(capacity.queued, 'soul')} waiting`
        : `${plural(capacity.embodied, 'life')} in open water`;
    }

    setQueue(message) {
      if (!message) {
        this.queueState.hidden = true;
        this.queueState.textContent = '';
        return;
      }
      this.queueState.hidden = false;
      this.birthCue.hidden = true;
      this.queueState.textContent = message.returningLife
        ? `your living fish is ${message.position === 1 ? 'next' : `${message.position} places`} from the foreground`
        : `the foreground is full; ${message.position === 1 ? 'your ripple is next' : `${message.position} ripples are ahead`}`;
    }

    showBirthCue(show) {
      this.birthCue.hidden = !show || !this.queueState.hidden;
    }

    showNotice(text, duration) {
      if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
      this.notice.textContent = text;
      this.notice.hidden = false;
      this.noticeTimer = setTimeout(() => {
        this.notice.hidden = true;
        this.notice.textContent = '';
      }, duration || 4200);
    }

    showLifeEnded(ageText, updateLineage = true) {
      this.showNotice(`${ageText}, now held in the dome`, 5200);
      this.showBirthCue(false);
      setTimeout(() => this.showBirthCue(true), 5200);
      if (updateLineage && this.identity) {
        this.setIdentity(Object.assign({}, this.identity, {
          completedLives: this.identity.completedLives + 1,
        }));
      }
    }

    showOfferingMenu(screenX, screenY, point) {
      this.offeringPoint = point;
      this.offeringMenu.style.left = `${Math.max(54, Math.min(innerWidth - 54, screenX))}px`;
      this.offeringMenu.style.top = `${Math.max(76, Math.min(innerHeight - 26, screenY))}px`;
      this.offeringMenu.hidden = false;
    }

    hideOfferingMenu() {
      this.offeringMenu.hidden = true;
      this.offeringPoint = null;
    }

    updateLabels(anchors) {
      const visible = new Set(anchors.map((anchor) => anchor.key));
      for (const [key, element] of this.labelElements) {
        if (visible.has(key)) continue;
        element.remove();
        this.labelElements.delete(key);
      }
      for (const anchor of anchors) {
        let element = this.labelElements.get(anchor.key);
        if (!element) {
          element = document.createElement('span');
          element.className = 'soul-label';
          this.labels.appendChild(element);
          this.labelElements.set(anchor.key, element);
        }
        element.textContent = anchor.text;
        element.style.left = `${anchor.x}px`;
        element.style.top = `${anchor.y}px`;
        element.style.setProperty('--label-color', anchor.color);
        element.classList.toggle('is-owned', !!anchor.owned);
        element.classList.toggle('is-cluster', !!anchor.cluster);
      }
    }

    updateLedgerClock(serverNow) {
      this.ledgerAge.textContent = poeticDuration(serverNow - this.pondBornAt);
    }

    updateMemories(memories) {
      this.memoryList.replaceChildren();
      for (const memory of memories.slice(0, 8)) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = memory.name;
        name.style.color = `#${Number(memory.tint).toString(16).padStart(6, '0')}`;
        const time = document.createElement('time');
        time.dateTime = new Date(memory.completedAt).toISOString();
        const days = Math.max(1, Math.round((Date.now() - memory.completedAt) / 86400000));
        time.textContent = days === 1 ? 'yesterday' : `${days} days ago`;
        item.append(name, time);
        this.memoryList.appendChild(item);
      }
    }

    openLedger() {
      if (!this.awakened) return;
      this.ledger.hidden = false;
      this.ledgerClose.focus();
    }

    closeLedger() {
      this.ledger.hidden = true;
    }
  }

  window.PondUI = PondUI;
}());
