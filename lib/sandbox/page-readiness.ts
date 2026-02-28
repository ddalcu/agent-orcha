import type { CDPClient } from './cdp-client.ts';

export interface PageSnapshot {
  url: string;
  title: string;
  readyState: string;
  inflightRequests: number;
  elements: string;
  headings: string[];
  summary: string;
}

interface ReadinessState {
  loadFired: boolean;
  inflightRequests: number;
  lastDomChange: number;
  lastNetworkActivity: number;
  networkTriggered: boolean;
}

const SETTLE_MS = 300;
const POLL_MS = 80;
const SETTLE_MAX_MS = 2_000;
/** Max time waitForReady will block — returns best-effort snapshot after this. */
const READY_MAX_MS = 8_000;
const MAX_ELEMENTS = 30;

/**
 * Injected JS that returns compact text lines + a ref→selector map.
 * Output format per element: "- role \"text\" [ref=eN] attrs..."
 * This is ~3-5x more token-efficient than JSON objects.
 */
const OBSERVE_SCRIPT = `(() => {
  const h = [...document.querySelectorAll('h1,h2,h3')].slice(0,8)
    .map(e=>e.textContent.trim().substring(0,60)).filter(Boolean);
  const els = document.querySelectorAll(
    'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]'
  );
  const lines=[], refs={};
  let n=0;
  for(const el of els){
    if(n>=${MAX_ELEMENTS})break;
    if(el.offsetParent===null&&el.tagName!=='INPUT'&&el.type!=='hidden')continue;
    const r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0&&el.type!=='hidden')continue;
    n++;
    const ref='e'+n;
    refs[ref]=bSel(el);
    const tag=el.tagName.toLowerCase();
    const role=el.getAttribute('role')||tag;
    const txt=(el.textContent||'').trim().substring(0,40);
    let line='- '+role;
    if(txt)line+=' "'+txt+'"';
    line+=' [ref='+ref+']';
    if(el.type&&el.type!=='submit'&&el.type!=='button')line+=' type='+el.type;
    if(el.name)line+=' name='+el.name;
    if(el.placeholder)line+=' placeholder="'+el.placeholder+'"';
    if(el.value!==undefined&&el.value!=='')line+=' value="'+el.value.substring(0,30)+'"';
    if(el.disabled)line+=' disabled';
    lines.push(line);
  }
  const tl=document.body?document.body.innerText.length:0;
  const fc=document.querySelectorAll('form').length;
  const ic=document.querySelectorAll('img').length;
  const sp=[];
  if(fc)sp.push(fc+' form(s)');
  if(ic)sp.push(ic+' image(s)');
  sp.push(tl+' chars');
  return JSON.stringify({
    url:location.href,title:document.title,readyState:document.readyState,
    headings:h,summary:sp.join(', '),
    elements:lines.join('\\n'),refs:refs
  });
  function bSel(el){
    if(el.id)return'#'+CSS.escape(el.id);
    if(el.name&&el.tagName){
      const s=el.tagName.toLowerCase()+'[name="'+el.name+'"]';
      if(document.querySelectorAll(s).length===1)return s;
    }
    const p=[];let c=el;
    while(c&&c!==document.body){
      const pr=c.parentElement;if(!pr)break;
      const sb=[...pr.children].filter(x=>x.tagName===c.tagName);
      p.unshift(sb.length===1?c.tagName.toLowerCase():c.tagName.toLowerCase()+':nth-of-type('+(sb.indexOf(c)+1)+')');
      c=pr;
    }
    return p.join(' > ');
  }
})()`;

export class PageReadiness {
  private cdp: CDPClient;
  private unsubscribers: (() => void)[] = [];
  private state: ReadinessState = {
    loadFired: false,
    inflightRequests: 0,
    lastDomChange: 0,
    lastNetworkActivity: 0,
    networkTriggered: false,
  };

  /** Maps short refs (e1, e2...) → CSS selectors. Updated on each observe(). */
  private refMap = new Map<string, string>();

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
  }

  async attach(): Promise<void> {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Network.enable');
    await this.cdp.send('DOM.enable');

    this.unsubscribers.push(
      this.cdp.on('Page.loadEventFired', () => {
        this.state.loadFired = true;
      }),
      this.cdp.on('Network.requestWillBeSent', () => {
        this.state.inflightRequests++;
        this.state.lastNetworkActivity = Date.now();
        this.state.networkTriggered = true;
      }),
      this.cdp.on('Network.loadingFinished', () => {
        this.state.inflightRequests = Math.max(0, this.state.inflightRequests - 1);
        this.state.lastNetworkActivity = Date.now();
      }),
      this.cdp.on('Network.loadingFailed', () => {
        this.state.inflightRequests = Math.max(0, this.state.inflightRequests - 1);
        this.state.lastNetworkActivity = Date.now();
      }),
      this.cdp.on('DOM.documentUpdated', () => {
        this.state.lastDomChange = Date.now();
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  resetForNavigation(): void {
    this.state.loadFired = false;
    this.state.inflightRequests = 0;
    this.state.lastDomChange = Date.now();
    this.state.lastNetworkActivity = Date.now();
    this.state.networkTriggered = false;
  }

  resetNetworkFlag(): void {
    this.state.networkTriggered = false;
  }

  hadNetworkActivity(): boolean {
    return this.state.networkTriggered;
  }

  /**
   * Wait for page readiness with progressive resolution:
   * - Ideal: load + network idle + DOM stable → immediate
   * - Good enough: load + DOM stable (lingering requests) → after 2s
   * - Hard cap: READY_MAX_MS (8s) regardless
   */
  async waitForReady(_timeout?: number): Promise<void> {
    const maxMs = Math.min(_timeout ?? READY_MAX_MS, READY_MAX_MS);
    const start = Date.now();

    await new Promise<void>((resolve) => {
      const check = async () => {
        const now = Date.now();
        const elapsed = now - start;

        if (elapsed > maxMs) { resolve(); return; }

        // Fallback: if loadFired event was missed, check readyState via DOM
        if (!this.state.loadFired && elapsed > 500) {
          try {
            const rs = await this.cdp.send('Runtime.evaluate', {
              expression: 'document.readyState',
              returnByValue: true,
            });
            if ((rs as any).result?.value === 'complete') {
              this.state.loadFired = true;
            }
          } catch { /* ignore */ }
        }

        const networkIdle = this.state.inflightRequests === 0
          && (now - this.state.lastNetworkActivity) > SETTLE_MS;
        const domStable = (now - this.state.lastDomChange) > SETTLE_MS;

        // Ideal: everything settled
        if (this.state.loadFired && networkIdle && domStable) {
          resolve(); return;
        }

        // Good enough: load + DOM stable, but lingering requests (analytics, long-poll)
        if (elapsed > 2_000 && this.state.loadFired && domStable) {
          resolve(); return;
        }

        setTimeout(check, POLL_MS);
      };
      check();
    });
  }

  async waitForSettle(quietMs: number): Promise<void> {
    const start = Date.now();

    await new Promise<void>((resolve) => {
      const check = () => {
        const now = Date.now();
        if (now - start > SETTLE_MAX_MS) { resolve(); return; }

        const idle = this.state.inflightRequests === 0
          && (now - this.state.lastNetworkActivity) > quietMs
          && (now - this.state.lastDomChange) > quietMs;

        if (idle) { resolve(); return; }
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });
  }

  /** Resolve a ref (e.g. "e3") or CSS selector to a CSS selector. */
  resolveRef(refOrSelector: string): string {
    return this.refMap.get(refOrSelector) ?? refOrSelector;
  }

  async observe(): Promise<PageSnapshot> {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: OBSERVE_SCRIPT,
      returnByValue: true,
    });

    const raw = (result as any).result?.value;
    const parsed = raw
      ? JSON.parse(raw)
      : { url: '', title: '', readyState: 'unknown', headings: [], summary: '', elements: '', refs: {} };

    // Update ref→selector map
    this.refMap.clear();
    if (parsed.refs) {
      for (const [ref, sel] of Object.entries(parsed.refs)) {
        this.refMap.set(ref, sel as string);
      }
    }

    return {
      url: parsed.url,
      title: parsed.title,
      readyState: parsed.readyState,
      headings: parsed.headings,
      summary: parsed.summary,
      elements: parsed.elements,
      inflightRequests: this.state.inflightRequests,
    };
  }
}
