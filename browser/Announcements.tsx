"use client";
import {useEffect,useRef,useState} from 'react';

export type Announcement = {id:string;title:string;body:string;version:string;created:number};
type Feed = {accountId:string;messages:Announcement[];dismissedId:string};
type LoadAnnouncements = (controller:AbortController) => Promise<unknown>;
const CHECK_INTERVAL = 60_000;
const STORAGE_PREFIX = 'raw.dismissed-announcement.';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function isAnnouncement(value:unknown): value is Announcement {
  if (!value || typeof value !== 'object') return false;
  const item = value as Announcement;
  return typeof item.id === 'string' && ID.test(item.id)
    && typeof item.title === 'string' && item.title.length <= 120
    && typeof item.body === 'string' && item.body.length <= 3000
    && typeof item.version === 'string' && item.version.length <= 40
    && Number.isSafeInteger(item.created) && item.created >= 0;
}

export function useAnnouncements(accountId:string|undefined, load:LoadAnnouncements) {
  const [feed,setFeed] = useState<Feed|null>(null);
  const loadRef = useRef(load);
  const dismissed = useRef(new Map<string,string>());

  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    if (!accountId) {
      setFeed(null);
      return;
    }
    const owner = accountId;
    const storageKey = STORAGE_PREFIX + owner;
    let dismissedId = dismissed.current.get(owner) || '';
    try { dismissedId = localStorage.getItem(storageKey) || dismissedId; } catch {}
    setFeed({accountId:owner,messages:[],dismissedId});

    let active = true;
    let lastCheck = -Infinity;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let pending:AbortController|null = null;

    function schedule() {
      clearTimeout(timer);
      if (!active || document.hidden || pending) return;
      timer = setTimeout(check, Math.max(0, lastCheck + CHECK_INTERVAL - performance.now()));
    }

    async function check() {
      if (!active || document.hidden || pending) return;
      lastCheck = performance.now();
      const controller = new AbortController();
      pending = controller;
      try {
        const values = await loadRef.current(controller);
        if (!active || controller.signal.aborted || !Array.isArray(values) || values.length > 50) return;
        const messages = values.filter(isAnnouncement);
        setFeed(current => current?.accountId === owner ? {...current,messages} : current);
      } catch (error) {
        if (active && !controller.signal.aborted && (error as {status?:number})?.status === 401) {
          setFeed(current => current?.accountId === owner ? {...current,messages:[]} : current);
        }
      } finally {
        pending = null;
        schedule();
      }
    }

    function visibilityChanged() {
      if (document.hidden) pending?.abort();
      schedule();
    }

    function storageChanged(event:StorageEvent) {
      if (event.key !== storageKey) return;
      const id = event.newValue || '';
      if (id && !ID.test(id)) return;
      dismissed.current.set(owner, id);
      setFeed(current => current?.accountId === owner ? {...current,dismissedId:id} : current);
    }

    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('storage', storageChanged);
    schedule();
    return () => {
      active = false;
      clearTimeout(timer);
      pending?.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('storage', storageChanged);
    };
  }, [accountId]);

  const current = feed?.accountId === accountId ? feed : null;
  const messages = current?.messages || [];
  const latest = messages[0];
  const notice = latest && latest.id !== current?.dismissedId ? latest : null;

  function dismiss() {
    if (!accountId || !notice) return;
    dismissed.current.set(accountId, notice.id);
    try { localStorage.setItem(STORAGE_PREFIX + accountId, notice.id); } catch {}
    setFeed(value => value?.accountId === accountId ? {...value,dismissedId:notice.id} : value);
  }

  return {messages,notice,dismiss};
}

export function AnnouncementNotice({item,onDismiss,onUpdates}:{item:Announcement;onDismiss:()=>void;onUpdates?:()=>void}) {
  return <aside className="panel global-announcement" aria-label="Raw announcement">
    <div className="global-announcement-copy" role="status">
      <span className="eyebrow">RAW ANNOUNCEMENT</span>
      <strong>{item.title}</strong>
      <p>{item.body.length > 180 ? item.body.slice(0,180) + '…' : item.body}</p>
    </div>
    <div className="actions">
      {onUpdates && <button type="button" className="quiet" onClick={onUpdates}>Read in Updates</button>}
      <button type="button" className="text-button" onClick={onDismiss}>Dismiss</button>
    </div>
  </aside>;
}
