/**
 * "AI providers" dialog: the dynamic list of AI companies / models. Any
 * number of entries of any kind (OpenAI, Gemini, fal.ai, Replicate…), each
 * with its own key, models per capability and kind-specific fields (rendered
 * by the generic ParamForm), a connection test, defaults per capability and
 * the "remember keys" choice.
 *
 * Edits apply immediately through `onChange` (the shell persists them with
 * saveAiSettings), so closing never loses anything; "Done" just closes.
 * Accessible modal: portal to <body>, labelled, focus trapped, Esc closes,
 * focus returns to the opener.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { I18nText } from '../../core/types';
import { defaultParams } from '../../core/types';
import type { AiCapability, AiSettings, ProviderConfig, ProviderKind, ProviderKindId } from '../../ai/types';
import { AI_CAPABILITIES } from '../../ai/types';
import { CAPABILITY_LABELS, PROVIDER_KINDS, configCapabilities, getProviderKind, hasConnectionTest, isProviderKindId, kindNeedsKey } from '../../ai/kinds';
import { LOCAL_PROVIDER_ID, providerUsable, supports } from '../../ai/settings';
import { routeFor } from '../../ai/transport';
import { errorToText } from '../../app/format';
import { useI18n } from '../i18n';
import { ParamForm } from '../ParamForm';
import { Switch } from '../ParamField';
import { IconAlert, IconCheck, IconEye, IconEyeOff, IconInfo, IconShield, IconSparkles, IconX } from '../icons';
import { IconExternal, IconKey, IconPlug, IconPlus, IconServer, IconTrash, KindMark } from './icons';
import { addProvider, defaultsOf, isSuggestedModel, removeProvider, setDefaultProvider, updateProvider } from './logic';
import './ai.css';

export const PROVIDER_TEXT = {
  title: { tr: 'Yapay zekâ sağlayıcıları', en: 'AI providers' },
  subtitle: {
    tr: 'İstediğiniz kadar sağlayıcı ve model ekleyin; stil, T-poz, gövde tamamlama ve eksik görünümler bunlarla üretilir.',
    en: 'Add as many providers and models as you like; styles, T-pose, body completion and missing views are generated with them.',
  },
  close: { tr: 'Kapat', en: 'Close' },
  done: { tr: 'Tamam', en: 'Done' },
  autosave: { tr: 'Değişiklikler anında kaydedilir.', en: 'Changes are saved as you go.' },
  add: { tr: 'Sağlayıcı ekle', en: 'Add provider' },
  providers: { tr: 'Sağlayıcılar', en: 'Providers' },
  noProviders: { tr: 'Henüz sağlayıcı yok.', en: 'No providers yet.' },
  server: { tr: 'Sunucu', en: 'Server' },
  serverHint: { tr: 'Anahtarı 3D Marker sunucusunda tutulan, yönetilen sağlayıcı', en: 'Managed provider; its key is kept on the 3D Marker server' },
  enabled: { tr: 'Etkin', en: 'Enabled' },
  enable: { tr: '{name} etkin', en: '{name} enabled' },
  ready: { tr: 'Kullanıma hazır', en: 'Ready to use' },
  defaults: { tr: 'Varsayılanlar', en: 'Defaults' },
  defaultsHint: { tr: 'Her iş için önce denenecek sağlayıcı.', en: 'The provider tried first for each task.' },
  noneForCap: { tr: '— sağlayıcı yok —', en: '— no provider —' },
  pick: { tr: '— seçin —', en: '— choose —' },
  localModel: { tr: 'Yerel (tarayıcıda, ücretsiz)', en: 'Local (in-browser, free)' },
  off: { tr: '(kapalı)', en: '(off)' },
  noServer: {
    tr: 'Sunucu yok (statik demo): yalnızca tarayıcıdan doğrudan çağrılan sağlayıcılar çalışır — {direct}. {proxy} için 3D Marker sunucusu gerekir.',
    en: 'No server (static demo): only providers called directly from the browser work — {direct}. {proxy} need the 3D Marker server.',
  },
  chooseKind: { tr: 'Sağlayıcı türünü seçin', en: 'Choose a provider type' },
  chooseKindHint: {
    tr: 'Aynı türden birden fazla ekleyebilirsiniz (ör. iki farklı OpenAI hesabı).',
    en: 'You can add several of the same type (e.g. two OpenAI accounts).',
  },
  browserDirect: { tr: 'Tarayıcıdan doğrudan', en: 'Browser-direct' },
  viaServer: { tr: 'Sunucu üzerinden', en: 'Via server' },
  needsServerKind: { tr: 'Sunucu gerekir; statik demoda çalışmaz.', en: 'Needs the server; does not work on the static demo.' },
  addKind: { tr: 'Ekle', en: 'Add' },
  addKindLabel: { tr: '{name} ekle', en: 'Add {name}' },
  back: { tr: 'Geri', en: 'Back' },
  docs: { tr: 'Belgeler', en: 'Docs' },
  getKey: { tr: 'Anahtar al', en: 'Get a key' },
  newTab: { tr: '(yeni sekmede açılır)', en: '(opens in a new tab)' },
  label: { tr: 'Ad', en: 'Name' },
  apiKey: { tr: 'API anahtarı', en: 'API key' },
  apiKeyOptional: { tr: 'API anahtarı (isteğe bağlı)', en: 'API key (optional)' },
  keyHint: {
    tr: 'Yalnızca bu tarayıcıda saklanır ve yalnızca {name} API’sine ya da 3D Marker sunucu vekiline gönderilir.',
    en: 'Stored only in this browser and sent only to the {name} API or to the 3D Marker server proxy.',
  },
  managedKey: {
    tr: 'Bu sağlayıcının anahtarı sunucuda tutulur; burada anahtar gerekmez. Buradaki değişiklikler yalnızca bu oturum içindir.',
    en: 'This provider’s key is kept on the server; no key is needed here. Changes made here last for this session only.',
  },
  show: { tr: 'Anahtarı göster', en: 'Show key' },
  hide: { tr: 'Anahtarı gizle', en: 'Hide key' },
  routeDirect: { tr: 'Tarayıcı → {kind} (doğrudan)', en: 'Browser → {kind} (direct)' },
  routeProxy: { tr: 'Tarayıcı → 3D Marker sunucusu → {kind}', en: 'Browser → 3D Marker server → {kind}' },
  models: { tr: 'Modeller', en: 'Models' },
  custom: { tr: 'Özel…', en: 'Custom…' },
  customModel: { tr: 'Model kimliği', en: 'Model id' },
  customHint: { tr: 'Sağlayıcının kabul ettiği herhangi bir model kimliği. Boş = önerilen ilk model.', en: 'Any model id the provider accepts. Empty = the first suggestion.' },
  options: { tr: 'Seçenekler', en: 'Options' },
  request: { tr: 'İstek', en: 'Request' },
  defaultFor: { tr: 'Varsayılan olduğu işler', en: 'Default for' },
  test: { tr: 'Bağlantıyı test et', en: 'Test connection' },
  testing: { tr: 'Test ediliyor…', en: 'Testing…' },
  testOk: { tr: 'Bağlantı başarılı.', en: 'Connection works.' },
  testFail: { tr: 'Bağlantı başarısız', en: 'Connection failed' },
  testUnsupported: { tr: 'Bu tür için bağlantı testi yok.', en: 'No connection test for this type.' },
  testHint: { tr: 'Anahtarı doğrulamak için ucuz bir istek gönderir (ör. model listesi).', en: 'Sends a cheap request (e.g. list models) to validate the key.' },
  remove: { tr: 'Sağlayıcıyı sil', en: 'Delete provider' },
  removeConfirm: { tr: '“{name}” silinsin mi? Anahtarı da bu tarayıcıdan silinir.', en: 'Delete “{name}”? Its key is removed from this browser too.' },
  removeYes: { tr: 'Sil', en: 'Delete' },
  cancel: { tr: 'Vazgeç', en: 'Cancel' },
  remember: { tr: 'Anahtarları bu cihazda hatırla', en: 'Remember keys on this device' },
  securityNote: {
    tr: 'Anahtarlar yalnızca bu tarayıcıda kalır (hatırlama kapalıyken sekme kapanınca silinir) ve yalnızca ilgili sağlayıcıya ya da 3D Marker sunucu vekiline gönderilir; vekil anahtarları saklamaz ve günlüğe yazmaz. Ortak kullanılan bilgisayarlarda hatırlamayı açmayın.',
    en: 'Keys stay in this browser (gone when the tab closes unless remembered) and are sent only to the provider’s API or to the 3D Marker server proxy, which never stores or logs them. Don’t turn this on on shared computers.',
  },
} satisfies Record<string, I18nText>;

/** Short capability names for the chips in the list. */
export const CAPABILITY_SHORT: Record<AiCapability, I18nText> = {
  'image-edit': { tr: 'Düzenleme', en: 'Edit' },
  'background-removal': { tr: 'Arka plan', en: 'Background' },
  'image-to-3d': { tr: '3B', en: '3D' },
  'multiview-to-3d': { tr: 'Çok görünüm', en: 'Multi-view' },
};

const T = PROVIDER_TEXT;
const CUSTOM = '__custom__';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AiSettings;
  onChange: (s: AiSettings) => void;
  serverAvailable: boolean;
}

export function ProviderSettingsDialog(props: Props) {
  if (!props.open || typeof document === 'undefined') return null;
  return createPortal(<SettingsDialog {...props} />, document.body);
}

type Pane = { kind: 'add' } | { kind: 'provider'; id: string };

interface TestResult {
  sig: string;
  state: 'running' | 'ok' | 'error';
  text?: I18nText;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function SettingsDialog({ onClose, settings, onChange, serverAvailable }: Props) {
  const { tx } = useI18n();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Pane>(() => (settings.providers[0] ? { kind: 'provider', id: settings.providers[0].id } : { kind: 'add' }));
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [customModels, setCustomModels] = useState<Record<string, boolean>>({});
  const focusNext = useRef<string | null>(null);
  const testCtrls = useRef(new Map<string, AbortController>());
  const downOnBackdrop = useRef(false);

  // The pane's provider may disappear (deleted, server list refreshed).
  const selected = pane.kind === 'provider' ? settings.providers.find((p) => p.id === pane.id) ?? null : null;
  const effectivePane: Pane = pane.kind === 'provider' && !selected ? (settings.providers[0] ? { kind: 'provider', id: settings.providers[0].id } : { kind: 'add' }) : pane;
  const current = effectivePane.kind === 'provider' ? settings.providers.find((p) => p.id === effectivePane.id) ?? null : null;

  // Focus into the dialog on open, back to the opener on close; abort running tests.
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const ctrls = testCtrls.current;
    return () => {
      for (const c of ctrls.values()) c.abort();
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  // After adding a provider: focus its key field (or its name when it needs none).
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    // The shell may apply onChange a render later: keep the request until the element exists.
    const els = dialogRef.current?.querySelectorAll<HTMLElement>('[data-focus-id]') ?? [];
    const el = Array.from(els).find((e) => e.dataset.focusId === target);
    if (!el) return;
    focusNext.current = null;
    el.focus();
  });

  /** Switches the right-hand pane; on phones (stacked layout) scrolls it into view. */
  const show = (next: Pane) => {
    setConfirmDelete(null);
    setPane(next);
    const stacked = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;
    if (stacked) requestAnimationFrame(() => mainRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Modal: page shortcuts (generate, cancel…) must not see these keys.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmDelete) setConfirmDelete(null);
      else onClose();
      return;
    }
    if (e.key === 'Tab') trapFocus(e, dialogRef.current);
  };

  const add = (kind: ProviderKindId) => {
    const r = addProvider(settings, kind);
    onChange(r.settings);
    show({ kind: 'provider', id: r.id });
    focusNext.current = kindNeedsKey(kind) ? `key-${r.id}` : `label-${r.id}`;
  };

  const update = (pid: string, patch: Parameters<typeof updateProvider>[2]) => onChange(updateProvider(settings, pid, patch));

  const remove = (pid: string) => {
    const idx = settings.providers.findIndex((p) => p.id === pid);
    const next = removeProvider(settings, pid);
    testCtrls.current.get(pid)?.abort();
    setConfirmDelete(null);
    onChange(next);
    const neighbour = next.providers[Math.min(idx, next.providers.length - 1)];
    setPane(neighbour ? { kind: 'provider', id: neighbour.id } : { kind: 'add' });
    focusNext.current = neighbour ? `select-${neighbour.id}` : 'add';
  };

  const runTest = async (cfg: ProviderConfig) => {
    const sig = configSig(cfg);
    testCtrls.current.get(cfg.id)?.abort();
    const ac = new AbortController();
    testCtrls.current.set(cfg.id, ac);
    setTests((m) => ({ ...m, [cfg.id]: { sig, state: 'running' } }));
    let result: TestResult;
    try {
      // The adapters load on demand (they stay out of the main bundle).
      const adapter = (await import('../../ai/adapters')).getAdapter(cfg.kind);
      if (!adapter.testConnection) throw new Error('unsupported');
      const r = await adapter.testConnection(cfg, ac.signal);
      result = { sig, state: r.ok ? 'ok' : 'error', text: r.message ? { tr: r.message, en: r.message } : undefined };
    } catch (e) {
      if (ac.signal.aborted) return;
      result = { sig, state: 'error', text: errorToText(e) };
    }
    if (ac.signal.aborted) return;
    testCtrls.current.delete(cfg.id);
    setTests((m) => ({ ...m, [cfg.id]: result }));
  };

  const directKinds = PROVIDER_KINDS.filter((k) => k.browserDirect).map((k) => k.name);
  const proxyKinds = PROVIDER_KINDS.filter((k) => !k.browserDirect).map((k) => k.name);

  return (
    <div
      className="ai-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className="ai-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid="ai-settings-dialog"
      >
        <header className="ai-dialog-head">
          <span className="ai-dialog-icon" aria-hidden="true">
            <IconSparkles size={18} />
          </span>
          <div className="ai-dialog-titles">
            <h2 id={`${id}-title`} className="ai-dialog-title">
              {tx(T.title)}
            </h2>
            <p id={`${id}-desc`} className="muted small">
              {tx(T.subtitle)}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={tx(T.close)} title={tx(T.close)} data-testid="ai-close">
            <IconX size={18} />
          </button>
        </header>

        {!serverAvailable && (
          <p className="ai-banner small" data-testid="ai-no-server">
            <IconInfo size={16} />
            <span>{tx(T.noServer, { direct: directKinds.join(', '), proxy: proxyKinds.join(', ') })}</span>
          </p>
        )}

        <div className="ai-dialog-body">
          <aside className="ai-side" aria-label={tx(T.providers)}>
            <button
              type="button"
              className={`btn btn-secondary btn-block ai-add-btn${effectivePane.kind === 'add' ? ' is-on' : ''}`}
              aria-pressed={effectivePane.kind === 'add'}
              data-testid="ai-add-provider"
              data-focus-id="add"
              onClick={() => show({ kind: 'add' })}
            >
              <IconPlus size={16} /> {tx(T.add)}
            </button>

            {settings.providers.length === 0 ? (
              <p className="muted small ai-side-empty">{tx(T.noProviders)}</p>
            ) : (
              <ul className="ai-plist">
                {settings.providers.map((p) => (
                  <ProviderRow
                    key={p.id}
                    cfg={p}
                    selected={current?.id === p.id}
                    serverAvailable={serverAvailable}
                    onSelect={() => show({ kind: 'provider', id: p.id })}
                    onEnabled={(v) => update(p.id, { enabled: v })}
                  />
                ))}
              </ul>
            )}

            <DefaultsSection settings={settings} onChange={onChange} />
          </aside>

          <div ref={mainRef} className="ai-main">
            {effectivePane.kind === 'add' || !current ? (
              <KindChooser
                serverAvailable={serverAvailable}
                onAdd={add}
                onBack={settings.providers.length ? () => show({ kind: 'provider', id: settings.providers[0].id }) : null}
              />
            ) : (
              <ProviderEditor
                key={current.id}
                cfg={current}
                settings={settings}
                serverAvailable={serverAvailable}
                test={tests[current.id]?.sig === configSig(current) ? tests[current.id] : undefined}
                customModels={customModels}
                onCustomModel={(cap, on) => setCustomModels((m) => ({ ...m, [`${current.id}|${cap}`]: on }))}
                onUpdate={(patch) => update(current.id, patch)}
                onDefault={(cap) => onChange(setDefaultProvider(settings, cap, current.id))}
                onTest={() => void runTest(current)}
                confirmingDelete={confirmDelete === current.id}
                onAskDelete={() => setConfirmDelete(current.id)}
                onCancelDelete={() => setConfirmDelete(null)}
                onDelete={() => remove(current.id)}
              />
            )}
          </div>
        </div>

        <footer className="ai-dialog-foot">
          <div className="ai-remember">
            <Switch id={`${id}-remember`} checked={settings.rememberKeys} onChange={(v) => onChange({ ...settings, rememberKeys: v })} label={tx(T.remember)} describedBy={`${id}-sec`} testId="ai-remember-keys" />
            <p id={`${id}-sec`} className="field-hint ai-security">
              <IconShield size={14} />
              <span>{tx(T.securityNote)}</span>
            </p>
          </div>
          <div className="ai-foot-actions">
            <span className="muted small">{tx(T.autosave)}</span>
            <button type="button" className="btn btn-primary" onClick={onClose} data-testid="ai-save">
              <IconCheck size={16} /> {tx(T.done)}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Identity of the settings a connection test depends on (a result is shown only while they are unchanged). */
function configSig(cfg: ProviderConfig): string {
  return JSON.stringify([cfg.kind, cfg.apiKey, cfg.values, cfg.models, !!cfg.managed]);
}

function kindOf(cfg: ProviderConfig): ProviderKind | null {
  return isProviderKindId(cfg.kind) ? getProviderKind(cfg.kind) : null;
}

function displayName(cfg: ProviderConfig): string {
  return cfg.label.trim() || kindOf(cfg)?.name || cfg.kind;
}

function ProviderRow({
  cfg,
  selected,
  serverAvailable,
  onSelect,
  onEnabled,
}: {
  cfg: ProviderConfig;
  selected: boolean;
  serverAvailable: boolean;
  onSelect: () => void;
  onEnabled: (v: boolean) => void;
}) {
  const { tx } = useI18n();
  const usable = providerUsable(cfg, serverAvailable);
  const name = displayName(cfg);
  const kind = kindOf(cfg);
  return (
    <li className={`ai-prow${selected ? ' is-selected' : ''}${cfg.enabled ? '' : ' is-off'}`} data-testid={`ai-provider-${cfg.id}`}>
      <button type="button" className="ai-prow-main" aria-current={selected ? 'true' : undefined} onClick={onSelect} data-testid={`ai-select-${cfg.id}`} data-focus-id={`select-${cfg.id}`}>
        {kind && <KindMark kind={kind.id} size={30} />}
        <span className="ai-prow-text">
          <span className="ai-prow-title">
            <span className="truncate">{name}</span>
            {cfg.managed && (
              <span className="pill ai-pill-server" title={tx(T.serverHint)}>
                {tx(T.server)}
              </span>
            )}
          </span>
          <span className={`ai-prow-status ${usable.ok ? 'is-ok' : 'is-warn'}`}>
            <span className="ai-dot" aria-hidden="true" />
            <span className="truncate" title={usable.ok ? undefined : tx(usable.reason ?? T.ready)}>
              {usable.ok ? tx(T.ready) : tx(usable.reason ?? T.ready)}
            </span>
          </span>
          <span className="ai-prow-caps">
            {configCapabilities(cfg).map((c) => (
              <span key={c} className="ai-cap">
                {tx(CAPABILITY_SHORT[c])}
              </span>
            ))}
          </span>
        </span>
      </button>
      <label className="switch ai-prow-switch" title={tx(T.enabled)}>
        <input type="checkbox" role="switch" checked={cfg.enabled} onChange={(e) => onEnabled(e.target.checked)} data-testid={`ai-enabled-${cfg.id}`} />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="visually-hidden">{tx(T.enable, { name })}</span>
      </label>
    </li>
  );
}

function DefaultsSection({ settings, onChange }: { settings: AiSettings; onChange: (s: AiSettings) => void }) {
  const { tx } = useI18n();
  const id = useId();
  return (
    <section className="ai-defaults" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="ai-section-title">
        {tx(T.defaults)}
      </h3>
      <p className="field-hint">{tx(T.defaultsHint)}</p>
      {AI_CAPABILITIES.map((cap) => {
        const options = settings.providers.filter((p) => supports(p, cap));
        // Background removal can always stay on the in-browser model.
        const local = cap === 'background-removal';
        const cur = settings.defaults[cap];
        const value = cur && options.some((p) => p.id === cur) ? cur : local ? LOCAL_PROVIDER_ID : '';
        return (
          <div className="field" key={cap}>
            <label className="field-label" htmlFor={`${id}-${cap}`}>
              {tx(CAPABILITY_LABELS[cap])}
            </label>
            <select
              id={`${id}-${cap}`}
              className="select ai-select-sm"
              value={value}
              disabled={options.length === 0 && !local}
              data-testid={`ai-default-${cap}`}
              onChange={(e) => e.target.value && onChange(setDefaultProvider(settings, cap, e.target.value))}
            >
              {local && <option value={LOCAL_PROVIDER_ID}>{tx(T.localModel)}</option>}
              {options.length === 0 && !local && <option value="">{tx(T.noneForCap)}</option>}
              {options.length > 0 && !value && <option value="">{tx(T.pick)}</option>}
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {displayName(p)}
                  {p.enabled ? '' : ` ${tx(T.off)}`}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  const { tx } = useI18n();
  return (
    <a className="ai-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <IconExternal size={12} />
      <span className="visually-hidden"> {tx(T.newTab)}</span>
    </a>
  );
}

function KindChooser({ serverAvailable, onAdd, onBack }: { serverAvailable: boolean; onAdd: (kind: ProviderKindId) => void; onBack: (() => void) | null }) {
  const { tx } = useI18n();
  return (
    <div className="ai-kinds" data-testid="ai-kind-chooser">
      <div className="ai-main-head">
        <div>
          <h3 className="ai-main-title">{tx(T.chooseKind)}</h3>
          <p className="muted small">{tx(T.chooseKindHint)}</p>
        </div>
        {onBack && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
            {tx(T.back)}
          </button>
        )}
      </div>
      <ul className="ai-kind-grid">
        {PROVIDER_KINDS.map((k) => (
          <li key={k.id} className="ai-kind" data-testid={`ai-kind-${k.id}`}>
            <div className="ai-kind-head">
              <KindMark kind={k.id} size={34} />
              <div className="ai-kind-name">
                <strong>{k.name}</strong>
                <span className={`ai-route ${k.browserDirect ? 'is-direct' : 'is-proxy'}`}>
                  {k.browserDirect ? <IconPlug size={12} /> : <IconServer size={12} />}
                  {tx(k.browserDirect ? T.browserDirect : T.viaServer)}
                </span>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAdd(k.id)} aria-label={tx(T.addKindLabel, { name: k.name })} data-testid={`ai-add-kind-${k.id}`}>
                <IconPlus size={14} /> {tx(T.addKind)}
              </button>
            </div>
            <p className="ai-kind-desc">{tx(k.description)}</p>
            <div className="ai-kind-caps">
              {k.capabilities.map((c) => (
                <span key={c} className="ai-cap">
                  {tx(CAPABILITY_LABELS[c])}
                </span>
              ))}
            </div>
            <div className="ai-kind-links small">
              <ExternalLink href={k.docsUrl}>{tx(T.docs)}</ExternalLink>
              {k.keyUrl && <ExternalLink href={k.keyUrl}>{tx(T.getKey)}</ExternalLink>}
            </div>
            {!serverAvailable && !k.browserDirect && (
              <p className="ai-warn small">
                <IconAlert size={13} /> {tx(T.needsServerKind)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProviderEditor({
  cfg,
  settings,
  serverAvailable,
  test,
  customModels,
  onCustomModel,
  onUpdate,
  onDefault,
  onTest,
  confirmingDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  cfg: ProviderConfig;
  settings: AiSettings;
  serverAvailable: boolean;
  test: TestResult | undefined;
  customModels: Record<string, boolean>;
  onCustomModel: (cap: AiCapability, on: boolean) => void;
  onUpdate: (patch: Parameters<typeof updateProvider>[2]) => void;
  onDefault: (cap: AiCapability) => void;
  onTest: () => void;
  confirmingDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { tx } = useI18n();
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [showKey, setShowKey] = useState(false);
  const kind = kindOf(cfg);

  useEffect(() => {
    if (confirmingDelete) cancelRef.current?.focus();
  }, [confirmingDelete]);

  if (!kind) return null;
  const name = displayName(cfg);
  const caps = configCapabilities(cfg);
  const usable = providerUsable(cfg, serverAvailable);
  // Test gating ignores the on/off switch: a disabled entry can still be checked.
  const testable = providerUsable({ ...cfg, enabled: true }, serverAvailable);
  const adapterTest = hasConnectionTest(cfg.kind);
  const route = routeFor(cfg);
  const modelCaps = caps.filter((c) => (kind.models[c] ?? []).length > 0);
  const defaultFor = defaultsOf(settings, cfg.id);
  const needsKey = kindNeedsKey(cfg.kind);

  return (
    <div className="ai-editor" data-testid={`ai-editor-${cfg.id}`}>
      <div className="ai-editor-head">
        <KindMark kind={kind.id} size={40} />
        <div className="ai-editor-titles">
          <h3 className="ai-main-title truncate">{name}</h3>
          <p className="ai-editor-meta small">
            <span>{kind.name}</span>
            <span className={`ai-route ${route === 'direct' ? 'is-direct' : 'is-proxy'}`}>
              {route === 'direct' ? <IconPlug size={12} /> : <IconServer size={12} />}
              {tx(route === 'direct' ? T.routeDirect : T.routeProxy, { kind: kind.name })}
            </span>
            {cfg.managed && (
              <span className="pill ai-pill-server" title={tx(T.serverHint)}>
                {tx(T.server)}
              </span>
            )}
          </p>
        </div>
      </div>

      <p className={`ai-usable ${usable.ok ? 'is-ok' : 'is-warn'}`} role="status" data-testid={`ai-status-${cfg.id}`}>
        {usable.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
        <span>{usable.ok ? tx(T.ready) : tx(usable.reason ?? T.ready)}</span>
      </p>

      <p className="ai-kind-desc">{tx(kind.description)}</p>
      <div className="ai-kind-links small">
        <ExternalLink href={kind.docsUrl}>{tx(T.docs)}</ExternalLink>
        {kind.keyUrl && !cfg.managed && <ExternalLink href={kind.keyUrl}>{tx(T.getKey)}</ExternalLink>}
      </div>

      <div className="fields">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-label`}>
            {tx(T.label)}
          </label>
          <input
            id={`${id}-label`}
            className="input"
            type="text"
            value={cfg.label}
            maxLength={80}
            placeholder={kind.name}
            data-testid={`ai-label-${cfg.id}`}
            data-focus-id={`label-${cfg.id}`}
            onChange={(e) => onUpdate({ label: e.target.value })}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== cfg.label) onUpdate({ label: v || kind.name });
            }}
          />
        </div>

        {cfg.managed ? (
          <p className="note small" data-testid={`ai-managed-${cfg.id}`}>
            <IconServer size={14} />
            <span>{tx(T.managedKey)}</span>
          </p>
        ) : (
          <div className="field">
            <label className="field-label" htmlFor={`${id}-key`}>
              <IconKey size={13} /> {tx(needsKey ? T.apiKey : T.apiKeyOptional)}
            </label>
            <div className="input-group">
              <input
                id={`${id}-key`}
                className="input ai-key-input"
                type={showKey ? 'text' : 'password'}
                value={cfg.apiKey}
                placeholder={kind.keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={`${id}-keyhint`}
                data-testid={`ai-key-${cfg.id}`}
                data-focus-id={`key-${cfg.id}`}
                onChange={(e) => onUpdate({ apiKey: e.target.value })}
              />
              <button type="button" className="icon-btn" onClick={() => setShowKey((v) => !v)} aria-label={tx(showKey ? T.hide : T.show)} aria-pressed={showKey} title={tx(showKey ? T.hide : T.show)}>
                {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </div>
            <p id={`${id}-keyhint`} className="field-hint">
              {tx(T.keyHint, { name: kind.name })}
            </p>
          </div>
        )}
      </div>

      {modelCaps.length > 0 && (
        <section className="ai-sub" aria-labelledby={`${id}-models`}>
          <h4 id={`${id}-models`} className="ai-section-title">
            {tx(T.models)}
          </h4>
          <div className="fields">
            {modelCaps.map((cap) => (
              <ModelField
                key={cap}
                cfg={cfg}
                cap={cap}
                custom={!!customModels[`${cfg.id}|${cap}`]}
                onCustom={(on) => onCustomModel(cap, on)}
                onChange={(model) => onUpdate({ models: { ...cfg.models, [cap]: model } })}
              />
            ))}
          </div>
        </section>
      )}

      {kind.fields.length > 0 && (
        <ParamForm
          id={`ai-fields-${cfg.id}`}
          title={tx(cfg.kind === 'custom-http' ? T.request : T.options)}
          specs={kind.fields}
          values={cfg.values}
          onChange={(key, v) => onUpdate({ values: { ...cfg.values, [key]: v } })}
          onReset={() => onUpdate({ values: defaultParams(kind.fields) })}
        />
      )}

      <section className="ai-sub" aria-labelledby={`${id}-defaults`}>
        <h4 id={`${id}-defaults`} className="ai-section-title">
          {tx(T.defaultFor)}
        </h4>
        <div className="ai-default-chips" role="group" aria-labelledby={`${id}-defaults`}>
          {caps.map((cap) => {
            const on = defaultFor.includes(cap);
            return (
              <button
                key={cap}
                type="button"
                className={`ai-cat${on ? ' is-on' : ''}`}
                aria-pressed={on}
                disabled={on || !supports(cfg, cap)}
                data-testid={`ai-default-${cfg.id}-${cap}`}
                onClick={() => onDefault(cap)}
              >
                {on && <IconCheck size={12} />} {tx(CAPABILITY_LABELS[cap])}
              </button>
            );
          })}
        </div>
      </section>

      <section className="ai-sub ai-test" aria-labelledby={`${id}-test`}>
        <div className="ai-test-row">
          <button
            id={`${id}-test`}
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onTest}
            disabled={!adapterTest || !testable.ok || test?.state === 'running'}
            title={!adapterTest ? tx(T.testUnsupported) : !testable.ok ? tx(testable.reason ?? T.testUnsupported) : tx(T.testHint)}
            data-testid={`ai-test-${cfg.id}`}
          >
            {test?.state === 'running' ? <span className="spinner spinner-sm" aria-hidden="true" /> : <IconPlug size={14} />}
            {tx(test?.state === 'running' ? T.testing : T.test)}
          </button>
          <span className="ai-test-result small" role="status" data-testid={`ai-test-result-${cfg.id}`}>
            {!adapterTest && <span className="muted">{tx(T.testUnsupported)}</span>}
            {test?.state === 'ok' && (
              <span className="status status-ok">
                <IconCheck size={14} /> {tx(T.testOk)}
                {test.text ? ` ${tx(test.text)}` : ''}
              </span>
            )}
            {test?.state === 'error' && (
              <span className="status status-danger">
                <IconAlert size={14} /> {tx(T.testFail)}
                {test.text ? `: ${tx(test.text)}` : ''}
              </span>
            )}
          </span>
        </div>
      </section>

      {!cfg.managed && (
        <div className="ai-danger-zone">
          {confirmingDelete ? (
            <div className="ai-confirm" role="group" aria-label={tx(T.remove)}>
              <p className="small">{tx(T.removeConfirm, { name })}</p>
              <div className="ai-confirm-actions">
                <button ref={cancelRef} type="button" className="btn btn-secondary btn-sm" onClick={onCancelDelete}>
                  {tx(T.cancel)}
                </button>
                <button type="button" className="btn btn-sm ai-btn-danger" onClick={onDelete} data-testid={`ai-delete-confirm-${cfg.id}`}>
                  <IconTrash size={14} /> {tx(T.removeYes)}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm ai-btn-danger-ghost" onClick={onAskDelete} data-testid={`ai-delete-${cfg.id}`}>
              <IconTrash size={14} /> {tx(T.remove)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}


function ModelField({
  cfg,
  cap,
  custom,
  onCustom,
  onChange,
}: {
  cfg: ProviderConfig;
  cap: AiCapability;
  custom: boolean;
  onCustom: (on: boolean) => void;
  onChange: (model: string) => void;
}) {
  const { tx } = useI18n();
  const id = useId();
  const suggestions = getProviderKind(cfg.kind).models[cap] ?? [];
  const value = cfg.models[cap] ?? '';
  const isCustom = custom || (value !== '' && !isSuggestedModel(cfg.kind, cap, value));
  const selectValue = isCustom ? CUSTOM : value || suggestions[0]?.id || CUSTOM;
  const note = !isCustom ? suggestions.find((m) => m.id === selectValue)?.note : undefined;
  return (
    <div className="field" data-testid={`ai-model-field-${cfg.id}-${cap}`}>
      <label className="field-label" htmlFor={`${id}-sel`}>
        {tx(CAPABILITY_LABELS[cap])}
      </label>
      <select
        id={`${id}-sel`}
        className="select"
        value={selectValue}
        data-testid={`ai-model-${cfg.id}-${cap}`}
        aria-describedby={note || isCustom ? `${id}-hint` : undefined}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            onCustom(true);
          } else {
            onCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {suggestions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label === m.id ? m.id : `${m.label} — ${m.id}`}
          </option>
        ))}
        <option value={CUSTOM}>{tx(T.custom)}</option>
      </select>
      {isCustom && (
        <input
          className="input ai-mono"
          type="text"
          value={value}
          placeholder={suggestions[0]?.id ?? ''}
          aria-label={`${tx(CAPABILITY_LABELS[cap])} — ${tx(T.customModel)}`}
          spellCheck={false}
          autoComplete="off"
          maxLength={200}
          data-testid={`ai-model-custom-${cfg.id}-${cap}`}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {(note || isCustom) && (
        <p id={`${id}-hint`} className="field-hint">
          {isCustom ? tx(T.customHint) : note ? tx(note) : ''}
        </p>
      )}
    </div>
  );
}

/** Keep Tab / Shift+Tab inside the dialog. */
function trapFocus(e: ReactKeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]') && el.getAttribute('aria-hidden') !== 'true');
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}
