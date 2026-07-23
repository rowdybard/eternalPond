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

  function approximateLifeAge(bornAt, now) {
    const elapsed = Math.max(0, now - Number(bornAt || now));
    if (elapsed < 60 * 60 * 1000) return 'newly born';
    const hours = Math.floor(elapsed / (60 * 60 * 1000));
    if (hours < 36) return `about ${plural(hours, 'hour')}`;
    const days = Math.max(1, Math.floor(hours / 24));
    return `about ${plural(days, 'day')}`;
  }

  function quietRemaining(endsAt, now) {
    if (!Number.isFinite(endsAt)) return 'no ending is held';
    const remaining = endsAt - now;
    if (remaining <= 0) return 'its passage is ending';
    if (remaining < 12 * 60 * 60 * 1000) return 'its passage is drawing near';
    if (remaining < 36 * 60 * 60 * 1000) return 'within a turning day';
    if (remaining < 4 * 24 * 60 * 60 * 1000) return 'a few days remain';
    return 'several days remain';
  }

  function currentLifeState(life) {
    if (!life) return 'remembered in the dome';
    if (life.status === 'resting' || life.memorialPhase === 'dome') return 'resting in the dome';
    if (life.lifeKind === 'eternal' || life.lifeKind === 'memorial') return 'eternal in the water';
    return 'living in the water';
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
      this.ledgerCurrentRows = [
        required('ledger-current-name-row'),
        required('ledger-current-state-row'),
        required('ledger-current-age-row'),
        required('ledger-current-passage-row'),
      ];
      this.ledgerCurrentName = required('ledger-current-name');
      this.ledgerCurrentState = required('ledger-current-state');
      this.ledgerCurrentAge = required('ledger-current-age');
      this.ledgerCurrentPassage = required('ledger-current-passage');
      this.memoryList = required('memory-list');
      this.ledgerCredentials = required('ledger-credentials');
      this.ledgerCredentialList = required('ledger-credential-list');
      this.reducedMotionInput = required('reduced-motion');
      this.largerLabelsInput = required('larger-labels');
      this.lifeArrival = required('life-arrival');
      this.lifeArrivalName = required('life-arrival-name');
      this.lifeArrivalInlineName = required('life-arrival-inline-name');
      this.lifeArrivalClose = required('life-arrival-close');
      this.lifeLetterForm = required('life-letter-form');
      this.lifeLetterEmail = required('life-letter-email');
      this.lifeLetterStatus = required('life-letter-status');
      this.publicSoulCard = required('public-soul-card');
      this.publicSoulName = required('public-soul-name');
      this.publicSoulState = required('public-soul-state');
      this.publicSoulDedication = required('public-soul-dedication');
      this.publicSoulRipple = required('public-soul-ripple');
      this.secureLinkCard = required('secure-link-card');
      this.secureLinkTitle = required('secure-link-title');
      this.secureLinkCopy = required('secure-link-copy');
      this.secureLinkAccept = required('secure-link-accept');
      this.secureLinkDismiss = required('secure-link-dismiss');
      this.ledgerSharing = required('ledger-sharing');
      this.ledgerSharingStatus = required('ledger-sharing-status');
      this.ledgerSharingToggle = required('ledger-sharing-toggle');
      this.ledgerShare = required('ledger-share');
      this.ledgerLetters = required('ledger-letters');
      this.ledgerLetterStatus = required('ledger-letter-status');
      this.ledgerLetterForm = required('ledger-letter-form');
      this.ledgerLetterEmail = required('ledger-letter-email');
      this.ledgerMortalLetterRow = required('ledger-mortal-letter-row');
      this.ledgerMortalLetters = required('ledger-mortal-letters');
      this.ledgerLetterResend = required('ledger-letter-resend');
      this.ledgerLetterUnsubscribe = required('ledger-letter-unsubscribe');
      this.ledgerKeeper = required('ledger-keeper');
      this.ledgerKeeperStatus = required('ledger-keeper-status');
      this.keeperCheckoutActions = required('keeper-checkout-actions');
      this.keeperMonthly = required('keeper-monthly');
      this.keeperYearly = required('keeper-yearly');
      this.keeperPortal = required('keeper-portal');
      this.keeperDedicationForm = required('keeper-dedication-form');
      this.keeperDedication = required('keeper-dedication');
      this.keeperWeeklyRow = required('keeper-weekly-row');
      this.keeperWeeklyLetters = required('keeper-weekly-letters');
      this.labelElements = new Map();
      this.offeringPoint = null;
      this.identity = null;
      this.pondBornAt = Date.now();
      this.awakened = false;
      this.noticeTimer = null;
      this.currentLife = null;
      this.sharing = null;
      this.letterPreference = null;
      this.keeper = null;
      this.publicSoul = null;
      this.credentials = [];
      this.secureLinkAllowSoulSwitch = false;
      this.credentialForgetArmed = null;
      this.credentialForgetButton = null;
      this.credentialForgetTimer = null;
      this.onSoundToggle = null;
      this.onCameraToggle = null;
      this.onReducedMotion = null;
      this.onOffering = null;
      this.onSetSharing = null;
      this.onShare = null;
      this.onSetPondLetter = null;
      this.onResendPondLetter = null;
      this.onUnsubscribePondLetters = null;
      this.onPublicRipple = null;
      this.onMemoryFocus = null;
      this.onSecureLinkAccept = null;
      this.onKeeperCheckout = null;
      this.onKeeperPortal = null;
      this.onKeeperUpdate = null;
      this.onSwitchCredential = null;
      this.onForgetCredential = null;

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
      this.lifeArrivalClose.addEventListener('click', () => { this.lifeArrival.hidden = true; });
      this.lifeLetterForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!this.lifeLetterForm.reportValidity() || !this.onSetPondLetter) return;
        this.onSetPondLetter({ email: this.lifeLetterEmail.value, mortalLetters: true });
      });
      this.ledgerLetterForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!this.ledgerLetterForm.reportValidity() || !this.onSetPondLetter) return;
        this.onSetPondLetter({ email: this.ledgerLetterEmail.value, mortalLetters: true });
      });
      this.ledgerMortalLetters.addEventListener('change', () => {
        if (this.onSetPondLetter) this.onSetPondLetter({ mortalLetters: this.ledgerMortalLetters.checked });
      });
      this.ledgerLetterResend.addEventListener('click', () => {
        if (this.onResendPondLetter) this.onResendPondLetter();
      });
      this.ledgerLetterUnsubscribe.addEventListener('click', () => {
        if (this.onUnsubscribePondLetters) this.onUnsubscribePondLetters();
      });
      this.ledgerSharingToggle.addEventListener('click', () => {
        if (this.onSetSharing) this.onSetSharing(!(this.sharing && this.sharing.enabled));
      });
      this.ledgerShare.addEventListener('click', () => {
        if (this.onShare) this.onShare(this.shareDetails());
      });
      this.publicSoulRipple.addEventListener('click', () => {
        if (this.onPublicRipple && this.publicSoul) this.onPublicRipple(this.publicSoul.slug);
      });
      this.secureLinkAccept.addEventListener('click', () => {
        if (this.onSecureLinkAccept) this.onSecureLinkAccept();
      });
      this.secureLinkDismiss.addEventListener('click', () => this.hideSecureLink());
      this.keeperMonthly.addEventListener('click', () => {
        if (this.onKeeperCheckout) this.onKeeperCheckout('month');
      });
      this.keeperYearly.addEventListener('click', () => {
        if (this.onKeeperCheckout) this.onKeeperCheckout('year');
      });
      this.keeperPortal.addEventListener('click', () => {
        if (this.onKeeperPortal) this.onKeeperPortal();
      });
      this.keeperDedicationForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (this.onKeeperUpdate) this.onKeeperUpdate({ dedication: this.keeperDedication.value });
      });
      this.keeperWeeklyLetters.addEventListener('change', () => {
        if (this.onKeeperUpdate) this.onKeeperUpdate({ weeklyLetters: this.keeperWeeklyLetters.checked });
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

    setWelcome(message) {
      this.setIdentity(message.identity);
      this.setCurrentLife(message.currentLife || null, message.serverTime || Date.now());
      this.setSharing(message.sharing || { enabled: false });
      this.setLetterPreference(message.pondLetters || {
        available: false,
        status: 'none',
        mortalLetters: false,
        keeperLetters: false,
      });
      this.setKeeper(message.keeper || { configured: false, eligible: false, state: 'none', weeklyLetters: false });
    }

    setCredentials(credentials) {
      this.resetCredentialForgetArm();
      this.credentials = Array.isArray(credentials) ? credentials.slice(0, 5) : [];
      this.ledgerCredentialList.replaceChildren();
      this.ledgerCredentials.hidden = this.credentials.length === 0;
      if (this.credentials.length === 0) return;
      for (const credential of this.credentials) {
        const row = document.createElement('div');
        row.className = 'credential-row';
        row.setAttribute('role', 'listitem');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'credential-switch';
        const credentialTint = Number.isFinite(credential.tint)
          ? Math.max(0, Math.min(0xffffff, Math.trunc(credential.tint)))
          : null;
        button.style.setProperty('--credential-color', credentialTint !== null
          ? `#${credentialTint.toString(16).padStart(6, '0')}`
          : 'var(--pond)');
        button.textContent = credential.active ? `${credential.name} · here now` : credential.name;
        button.disabled = !!credential.active;
        if (credential.active) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => {
          if (this.onSwitchCredential) this.onSwitchCredential(credential.id);
        });
        const forget = document.createElement('button');
        forget.type = 'button';
        forget.className = 'credential-forget';
        forget.textContent = 'forget this key';
        forget.setAttribute('aria-label', `Forget this browser key for ${credential.name}`);
        forget.addEventListener('click', () => this.armCredentialForget(credential, forget));
        row.append(button, forget);
        this.ledgerCredentialList.append(row);
      }
    }

    armCredentialForget(credential, button) {
      if (this.credentialForgetArmed === credential.id) {
        this.resetCredentialForgetArm();
        if (this.onForgetCredential) this.onForgetCredential(credential.id);
        return;
      }
      this.resetCredentialForgetArm();
      this.credentialForgetArmed = credential.id;
      this.credentialForgetButton = button;
      button.textContent = 'confirm forget';
      button.classList.add('is-armed');
      this.showNotice(credential.active
        ? 'Confirm to revoke this active browser key. Another saved soul will open, or a new one will begin.'
        : 'Confirm to revoke only this saved browser key.');
      this.credentialForgetTimer = setTimeout(() => this.resetCredentialForgetArm(), 8000);
    }

    resetCredentialForgetArm() {
      if (this.credentialForgetTimer !== null) clearTimeout(this.credentialForgetTimer);
      this.credentialForgetTimer = null;
      this.credentialForgetArmed = null;
      if (this.credentialForgetButton && this.credentialForgetButton.isConnected) {
        this.credentialForgetButton.textContent = 'forget this key';
        this.credentialForgetButton.classList.remove('is-armed');
      }
      this.credentialForgetButton = null;
    }

    setCredentialBusy(busy) {
      for (const button of this.ledgerCredentialList.querySelectorAll('button')) {
        button.disabled = !!busy || button.matches('.credential-switch[aria-current="true"]');
      }
    }

    setSnapshot(snapshot) {
      this.pondBornAt = snapshot.pondBornAt;
      this.updatePresence(snapshot.connectedSouls, snapshot.capacity);
      this.ledgerRipples.textContent = Number(snapshot.foundingRipples || 0).toLocaleString();
      this.ledgerAge.textContent = poeticDuration(snapshot.serverTime - snapshot.pondBornAt);
      this.updateMemories(snapshot.memories || []);
      if (this.identity) {
        const entity = (snapshot.entities || []).find((item) => item.kind === 'soulFish' && item.soulId === this.identity.id);
        if (entity) {
          this.setCurrentLife({
            lifeId: entity.lifeId,
            entityId: entity.id,
            name: entity.label || this.identity.name,
            lifeKind: entity.lifeKind === 'memorial' ? 'eternal' : 'mortal',
            status: entity.memorialPhase === 'dome' ? 'resting' : 'living',
            bornAt: entity.bornAt,
            endsAt: entity.endsAt,
            memorialPhase: entity.memorialPhase,
            tint: entity.tint,
          }, snapshot.serverTime);
        }
      }
    }

    setCurrentLife(life, serverNow) {
      if (life) this.currentLife = Object.assign({}, this.currentLife || {}, life);
      else if (!this.currentLife || this.currentLife.status !== 'remembered') this.currentLife = null;
      const visible = !!this.currentLife;
      for (const row of this.ledgerCurrentRows) row.hidden = !visible;
      if (!visible) return;
      const now = Number(serverNow || Date.now());
      this.ledgerCurrentName.textContent = this.currentLife.name || this.identity && this.identity.name || 'this soul';
      this.ledgerCurrentState.textContent = currentLifeState(this.currentLife);
      if (this.currentLife.status === 'remembered') {
        this.ledgerCurrentAge.textContent = this.currentLife.ageText || 'a completed passage';
        this.ledgerCurrentPassage.textContent = 'held beneath the dome';
      } else {
        this.ledgerCurrentAge.textContent = approximateLifeAge(this.currentLife.bornAt, now);
        this.ledgerCurrentPassage.textContent = quietRemaining(this.currentLife.endsAt, now);
      }
    }

    showLifeStarted(life) {
      this.setCurrentLife(life, Date.now());
      const name = life && life.name || this.identity && this.identity.name || 'This soul';
      this.lifeArrivalName.textContent = name;
      this.lifeArrivalInlineName.textContent = name;
      this.lifeArrival.hidden = false;
      this.awaken();
    }

    rememberCurrentLife(ageText, completedAt, memory) {
      const remembered = Object.assign({}, this.currentLife || {}, {
        name: memory && memory.name || this.currentLife && this.currentLife.name || this.identity && this.identity.name || 'this soul',
        status: 'remembered',
        ageText,
        completedAt: memory && memory.completedAt || completedAt || Date.now(),
        tint: memory && memory.tint || this.currentLife && this.currentLife.tint,
        memorialPoint: memory && Number.isFinite(memory.x) && Number.isFinite(memory.z)
          ? { x: memory.x, z: memory.z }
          : this.currentLife && this.currentLife.memorialPoint,
      });
      this.currentLife = remembered;
      this.setCurrentLife(remembered, completedAt || Date.now());
      const ledgerMemory = memory || {
        name: remembered.name,
        tint: remembered.tint || this.identity && this.identity.tint || 0x79d1c2,
        completedAt: remembered.completedAt,
      };
      const existing = [...this.memoryList.children].some((item) => item.dataset.completedAt === String(ledgerMemory.completedAt));
      if (!existing) this.prependMemory(ledgerMemory);
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

    showLifeEnded(ageText, updateLineage = true, completedAt, memory) {
      this.showNotice(`${ageText}, now held in the dome`, 5200);
      this.showBirthCue(false);
      setTimeout(() => this.showBirthCue(true), 5200);
      this.rememberCurrentLife(ageText, completedAt, memory);
      if (updateLineage && this.identity) {
        this.setIdentity(Object.assign({}, this.identity, {
          completedLives: this.identity.completedLives + 1,
        }));
      }
    }

    setSharing(summary) {
      this.sharing = Object.assign({ enabled: false }, summary || {});
      this.ledgerSharing.hidden = !this.identity;
      this.ledgerSharingStatus.textContent = this.sharing.enabled
        ? 'This soul has a quiet public page.'
        : 'This soul is private to the pond.';
      this.ledgerSharingToggle.textContent = this.sharing.enabled ? 'make this page private' : 'make a public page';
      this.ledgerShare.hidden = !this.sharing.enabled || !this.sharing.url;
      this.ledgerSharingToggle.disabled = false;
      this.ledgerShare.disabled = false;
    }

    setSharingBusy(busy) {
      this.ledgerSharingToggle.disabled = !!busy;
      this.ledgerShare.disabled = !!busy;
    }

    shareDetails() {
      const current = this.currentLife || {};
      return {
        name: current.name || this.identity && this.identity.name || 'A quiet soul',
        tint: Number.isFinite(current.tint) ? current.tint : this.identity && this.identity.tint,
        status: currentLifeState(current),
        age: current.status === 'remembered' ? current.ageText : approximateLifeAge(current.bornAt, Date.now()),
        passage: current.status === 'remembered' ? 'held beneath the dome' : quietRemaining(current.endsAt, Date.now()),
        dedication: this.keeper && this.keeper.dedication,
        keeperAccent: (current.lifeKind === 'eternal' || current.lifeKind === 'memorial') && current.status !== 'remembered',
        url: this.sharing && this.sharing.url,
      };
    }

    setLetterPreference(preference, options) {
      const previousStatus = this.letterPreference && this.letterPreference.status;
      this.letterPreference = Object.assign({
        available: false,
        status: 'none',
        mortalLetters: false,
        keeperLetters: false,
      }, preference || {});
      const status = this.letterPreference.status;
      const available = this.letterPreference.available !== false;
      this.ledgerLetters.hidden = !available;
      this.lifeLetterForm.hidden = !available || status === 'pending' || status === 'confirmed' || status === 'suppressed';
      this.ledgerLetterForm.hidden = !available || status === 'pending' || status === 'confirmed' || status === 'suppressed';
      this.ledgerMortalLetterRow.hidden = status !== 'confirmed';
      this.ledgerMortalLetters.checked = !!this.letterPreference.mortalLetters;
      this.ledgerLetterResend.hidden = status !== 'pending';
      this.ledgerLetterUnsubscribe.hidden = status !== 'pending' && status !== 'confirmed';

      if (!available) {
        this.ledgerLetterStatus.textContent = 'Pond Letters are not configured here yet.';
        this.lifeLetterStatus.textContent = 'Pond Letters are not configured here yet.';
      } else if (status === 'pending') {
        const destination = this.letterPreference.maskedEmail ? ` at ${this.letterPreference.maskedEmail}` : '';
        this.ledgerLetterStatus.textContent = `A confirmation is waiting${destination}. No life letter is active yet.`;
        this.lifeLetterStatus.textContent = 'Check your inbox to let the pond remember this address.';
      } else if (status === 'confirmed') {
        const destination = this.letterPreference.maskedEmail ? ` ${this.letterPreference.maskedEmail}` : '';
        this.ledgerLetterStatus.textContent = `The pond can write to${destination}.`;
        this.lifeLetterStatus.textContent = 'The pond will write once when this life ends.';
      } else if (status === 'suppressed') {
        this.ledgerLetterStatus.textContent = 'Letters are quiet after a delivery could not be accepted.';
        this.lifeLetterStatus.textContent = 'This address cannot receive a Pond Letter.';
      } else if (status === 'unsubscribed') {
        this.ledgerLetterStatus.textContent = 'The pond will remain quiet. You can choose a new address anytime.';
        this.lifeLetterStatus.textContent = '';
      } else {
        this.ledgerLetterStatus.textContent = 'Leave an address only if you want one letter when a mortal life ends.';
        this.lifeLetterStatus.textContent = '';
      }

      if (options && options.trackConfirmation && previousStatus !== 'confirmed' && status === 'confirmed'
        && window.PondAnalytics) window.PondAnalytics.track('email_opt_in');
    }

    setLetterBusy(busy) {
      for (const element of [
        this.lifeLetterEmail,
        this.ledgerLetterEmail,
        this.ledgerMortalLetters,
        this.ledgerLetterResend,
        this.ledgerLetterUnsubscribe,
        ...this.lifeLetterForm.querySelectorAll('button'),
        ...this.ledgerLetterForm.querySelectorAll('button'),
      ]) element.disabled = !!busy;
    }

    setKeeper(summary) {
      this.keeper = Object.assign({
        configured: false,
        eligible: false,
        requiresConfirmedEmail: false,
        state: 'none',
        weeklyLetters: false,
      }, summary || {});
      const keeper = this.keeper;
      this.ledgerKeeper.hidden = !keeper.configured;
      this.keeperCheckoutActions.hidden = true;
      this.keeperPortal.hidden = true;
      this.keeperDedicationForm.hidden = true;
      this.keeperWeeklyRow.hidden = true;
      if (!keeper.configured) return;

      if (!keeper.eligible && keeper.state === 'none') {
        this.ledgerKeeperStatus.textContent = 'Pond keeping appears only after a completed mortal life or a genuine return.';
      } else if ((keeper.state === 'none' || keeper.state === 'eligible') && keeper.requiresConfirmedEmail) {
        this.ledgerKeeperStatus.textContent = 'Confirm a recovery address before choosing an eternal fish.';
      } else if (keeper.state === 'none' || keeper.state === 'eligible') {
        this.ledgerKeeperStatus.textContent = 'Keep one fish without a natural ending: $3 monthly or $30 yearly.';
        this.keeperCheckoutActions.hidden = false;
      } else if (keeper.state === 'pending') {
        this.ledgerKeeperStatus.textContent = 'The pond is waiting for the first paid invoice before changing this life.';
      } else {
        const paidThrough = Number.isFinite(keeper.paidThroughAt)
          ? ` through ${new Date(keeper.paidThroughAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
          : '';
        const stateText = keeper.state === 'active'
          ? `This eternal fish is held in the water${paidThrough}.`
          : keeper.state === 'canceling'
            ? `This fish remains in the water${paidThrough}, then rests in the dome.`
            : keeper.state === 'past_due'
              ? `Keeping needs attention; the fish remains held${paidThrough}.`
              : 'This eternal fish is resting in the dome.';
        this.ledgerKeeperStatus.textContent = stateText;
        this.keeperPortal.hidden = false;
        this.keeperDedicationForm.hidden = false;
        this.keeperWeeklyRow.hidden = false;
        this.keeperDedication.value = keeper.dedication || '';
        this.keeperWeeklyLetters.checked = !!keeper.weeklyLetters;
      }
    }

    setKeeperBusy(busy) {
      for (const element of [
        this.keeperMonthly,
        this.keeperYearly,
        this.keeperPortal,
        this.keeperDedication,
        this.keeperWeeklyLetters,
        ...this.keeperDedicationForm.querySelectorAll('button'),
      ]) element.disabled = !!busy;
    }

    setPublicSoul(soul) {
      this.publicSoul = soul || null;
      this.publicSoulCard.hidden = !soul;
      if (!soul) return;
      this.publicSoulName.textContent = soul.name;
      const stateText = soul.status === 'alive'
        ? `${soul.currentLife && soul.currentLife.ageText || 'A living soul'} moves in the shared water.${soul.currentLife && soul.currentLife.remainingPassageText ? ` ${soul.currentLife.remainingPassageText}.` : ''}`
        : soul.status === 'resting'
          ? 'This eternal soul is resting beneath the dome.'
          : `${soul.latestMemorial && soul.latestMemorial.ageText || 'A completed life'} is held beneath the dome.`;
      const lineage = soul.completedLives > 0
        ? ` The pond remembers ${plural(soul.completedLives, 'completed life', 'completed lives')}.`
        : '';
      this.publicSoulState.textContent = `${stateText}${lineage}`;
      this.publicSoulDedication.hidden = !soul.dedication;
      this.publicSoulDedication.textContent = soul.dedication || '';
      this.publicSoulRipple.disabled = false;
      document.title = `${soul.name} \u00b7 eternal pond`;
      const canonical = document.querySelector('link[rel="canonical"]') || document.head.appendChild(document.createElement('link'));
      canonical.rel = 'canonical';
      canonical.href = `${location.origin}/s/${encodeURIComponent(soul.slug)}`;
      const ogTitle = document.querySelector('meta[property="og:title"]');
      const ogUrl = document.querySelector('meta[property="og:url"]');
      if (ogTitle) ogTitle.content = `${soul.name} \u00b7 eternal pond`;
      if (ogUrl) ogUrl.content = canonical.href;
    }

    setPublicRippleBusy(busy) {
      this.publicSoulRipple.disabled = !!busy;
    }

    showSecureLink(inspection, hasCurrentSoul) {
      this.secureLinkCard.hidden = false;
      this.secureLinkAccept.disabled = false;
      this.secureLinkAllowSoulSwitch = !!(inspection && inspection.purpose === 'return_soul' && hasCurrentSoul);
      const name = inspection && inspection.name || 'a remembered soul';
      if (inspection && inspection.purpose === 'return_soul') {
        this.secureLinkTitle.textContent = `Return to ${name}`;
        this.secureLinkCopy.textContent = hasCurrentSoul
          ? `Another soul is already remembered in this browser. Following this path will switch the water to ${name}; both paths remain saved here.`
          : `This private path can return ${name} to this browser.`;
        this.secureLinkAccept.textContent = 'return to this soul';
      } else {
        this.secureLinkTitle.textContent = 'A remembered path is waiting.';
        this.secureLinkCopy.textContent = 'Follow this private path to finish the request made from the pond.';
        this.secureLinkAccept.textContent = 'follow this path';
      }
    }

    setSecureLinkBusy(busy) {
      this.secureLinkAccept.disabled = !!busy;
      this.secureLinkDismiss.disabled = !!busy;
    }

    requireSecureLinkSwitch(result) {
      const name = result && result.name || 'that remembered soul';
      this.secureLinkAllowSoulSwitch = true;
      this.secureLinkTitle.textContent = `Continue for ${name}`;
      this.secureLinkCopy.textContent = result && result.purpose === 'return_soul'
        ? `Another soul is active in this browser. Continue to switch the water to ${name}; both paths will remain saved here.`
        : `Another soul is active in this browser. Continue only if you mean to apply this private request to ${name}.`;
      this.secureLinkAccept.textContent = result && result.purpose === 'return_soul'
        ? 'switch and follow this path'
        : 'continue for this soul';
    }

    allowsSecureLinkSwitch() {
      return this.secureLinkAllowSoulSwitch;
    }

    hideSecureLink() {
      this.secureLinkCard.hidden = true;
      this.secureLinkAllowSoulSwitch = false;
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
      if (this.currentLife) this.setCurrentLife(this.currentLife, serverNow);
    }

    updateMemories(memories) {
      this.memoryList.replaceChildren();
      for (const memory of memories.slice(0, 8).reverse()) this.prependMemory(memory);
    }

    prependMemory(memory) {
      const item = document.createElement('li');
      item.dataset.completedAt = String(memory.completedAt);
      const focusable = Number.isFinite(memory.x) && Number.isFinite(memory.z);
      const name = document.createElement(focusable ? 'button' : 'span');
      name.textContent = memory.name;
      name.style.color = `#${Number(memory.tint || 0x79d1c2).toString(16).padStart(6, '0')}`;
      if (focusable) {
        name.type = 'button';
        name.className = 'memory-focus';
        name.addEventListener('click', () => {
          if (this.onMemoryFocus) this.onMemoryFocus(memory);
        });
      }
      const time = document.createElement('time');
      time.dateTime = new Date(memory.completedAt).toISOString();
      const elapsed = Date.now() - memory.completedAt;
      const days = Math.max(0, Math.floor(elapsed / 86400000));
      time.textContent = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
      item.append(name, time);
      this.memoryList.prepend(item);
      while (this.memoryList.children.length > 8) this.memoryList.lastElementChild.remove();
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
