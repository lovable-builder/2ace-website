import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ErrorInfo, type InputHTMLAttributes, type ReactNode } from 'react';
import { report } from './lib/config';
import { initialLang, translate, useT } from './i18n';

// A labelled input. The label text sits above the box, as on the rest of the site.
export function Field({ label, bad, className, children, ...input }: { label: ReactNode; bad?: boolean; children?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={'field' + (bad ? ' bad' : '') + (className ? ' ' + className : '')}>
      {label}
      {children ?? <input {...input} />}
    </label>
  );
}

// A tick box drawn as a button (bigger to tap than a checkbox), with its sentence next to it.
export function Tick({ on, bad, onToggle, children }: { on: boolean; bad?: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} className={'tick' + (on ? ' on' : '') + (bad ? ' bad' : '')} onClick={onToggle}>
      <span className="box" aria-hidden="true">{on ? '✓' : ''}</span>
      <span>{children}</span>
    </button>
  );
}

// A dark status line that goes away when clicked.
export function Note({ text, onClear }: { text: string; onClear?: () => void }) {
  if (!text) return null;
  return <div role="status" className={'note' + (onClear ? ' clickable' : '')} onClick={onClear}>{text}</div>;
}

export function ErrLine({ text }: { text: string }) {
  const t = useT();
  return text ? <p className="errline" role="alert">{t(text)}</p> : null;
}

// ---- toast ----
const ToastContext = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((m: string) => { setMsg(m); clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(''), 2800); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <ToastContext.Provider value={show}>{children}{msg ? <div className="toast" role="status">{msg}</div> : null}</ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);

// ---- a crash in one screen shows a calm message instead of a blank page, and is reported ----
export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(e: Error, info: ErrorInfo) { report(e, { componentStack: info.componentStack?.slice(0, 2000) }); }
  render() {
    if (!this.state.crashed) return this.props.children;
    const lang = initialLang();
    return (
      <div className="center">
        <div className="stack-sm" style={{ maxWidth: '46ch' }}>
          <h1 className="h1">{translate(lang, 'Something went wrong on this page.')}</h1>
          <p className="sub">{translate(lang, 'Nothing you saved is lost. Reload the page to try again. If it happens again, write to hello@2ace.pl.')}</p>
          <button className="btn" onClick={() => location.reload()}>{translate(lang, 'Reload')}</button>
        </div>
      </div>
    );
  }
}

export const scrollTop = () => { try { window.scrollTo(0, 0); } catch { /* jsdom */ } };
