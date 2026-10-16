from __future__ import annotations

import json
import statistics
from datetime import date, datetime, timedelta
from html import escape

from .model import band_min, display_ticker, parse_date

WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

CSS = r"""
:root{
 --ink:#111;--ink2:#333;--mut:#666;--mut2:#8a8a8a;--rule:#e2e2e2;--rule2:#cfcfcf;--bg:#fff;--off:#f7f7f5;
 --up:#0b8a3e;--dn:#d0182a;--mx:#b06a00;--fl:#6b6b6b;--link:#1a3fd1;--hold:#fff0b3;--holdb:#d8a800;
 --serif:"Source Serif 4","Noto Serif TC","Source Han Serif TC","Noto Serif CJK TC","Songti TC","PMingLiU",Georgia,"Times New Roman",serif;
 --sans:Inter,"Helvetica Neue",Helvetica,Arial,"PingFang HK","PingFang TC","Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei",sans-serif;
 --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,"PingFang HK","Noto Sans TC",monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px}
.num,.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.mast{background:#000;color:#fff}
.mast-in{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:60px;padding-top:10px;padding-bottom:10px}
.logo{text-decoration:none;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}
.logo .en{font-family:var(--serif);font-weight:700;font-size:26px;letter-spacing:.02em;line-height:1}
.logo .zh{font-size:13px;font-weight:500;color:#bdbdbd;letter-spacing:.08em}
.mast-r{display:flex;align-items:center;gap:16px;font-size:12px;color:#cfcfcf;white-space:nowrap}
.mast-r .d{font-family:var(--mono);letter-spacing:.04em}
.mast-r a{color:#fff;text-decoration:none;font-weight:600;border:1px solid #555;padding:4px 10px;border-radius:2px}
.mast-r a:hover{border-color:#fff}
@media(max-width:560px){.mast-r .d{display:none}.logo .zh{display:none}}
.edition{padding:26px 0 18px;border-bottom:1px solid var(--rule)}
.kicker{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.kicker .sep{color:var(--mut2);margin:0 6px}
.edition h1{font-family:var(--serif);font-weight:700;font-size:clamp(28px,4.2vw,42px);line-height:1.2;letter-spacing:-.005em;margin:8px 0 6px}
.edition h1 .zh{font-size:.62em;color:var(--mut);font-weight:600;margin-left:10px;letter-spacing:.02em;white-space:nowrap}
.dek{color:var(--ink2);font-size:15px}
.byl{margin-top:10px;font-size:12px;color:var(--mut);display:flex;flex-wrap:wrap;gap:6px 14px}
.byl .num{color:var(--ink2)}
.whylink{color:var(--link);text-decoration:none;font-weight:600}.whylink:hover{text-decoration:underline}
.stale{background:#fdecee;color:#8a0f1c;font-weight:600;padding:1px 7px;border-radius:2px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--rule)}
.stat{padding:16px 16px 14px 0}
.stat+.stat{border-left:1px solid var(--rule);padding-left:16px}
.stat .k{font-size:10.5px;letter-spacing:.12em;font-weight:700;text-transform:uppercase;color:var(--mut)}
.stat .k .zh{letter-spacing:.04em;margin-left:4px;font-weight:600}
.stat .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:26px;font-weight:600;line-height:1.25;margin-top:2px}
.stat .s{font-size:12px;color:var(--mut)}
@media(max-width:700px){.stats{grid-template-columns:1fr 1fr}.stat:nth-child(3){border-left:0;padding-left:0}.stat:nth-child(n+3){border-top:1px solid var(--rule)}}
.sh{border-top:3px solid #000;padding-top:8px;margin:30px 0 12px;display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.sh h2{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap}
.sh h2 .zh{font-size:15px;letter-spacing:.04em;margin-right:8px}
.sh .aux{font-size:12px;color:var(--mut)}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-bottom:6px}
.seg{display:inline-flex;border:1px solid var(--ink);border-radius:2px;overflow:hidden}
.seg button,.tog{font:600 12.5px/1 var(--sans);letter-spacing:.02em;background:#fff;color:var(--ink2);border:0;padding:8px 11px;cursor:pointer;white-space:nowrap}
.seg button+button{border-left:1px solid var(--rule2)}
.seg button[aria-pressed=true]{background:#000;color:#fff}
.seg button:focus-visible,.tog:focus-visible,select:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.tog{border:1px solid var(--rule2);border-radius:2px;display:inline-flex;align-items:center;gap:6px}
.tog[aria-pressed=true]{border-color:var(--up);color:var(--up);background:#eef8f1}
.tog i{width:8px;height:8px;border-radius:1px;background:currentColor;display:inline-block}
.sortw{margin-left:auto;font-size:12px;color:var(--mut);display:flex;align-items:center;gap:6px}
select{font:500 12.5px var(--sans);border:1px solid var(--rule2);border-radius:2px;padding:6px 8px;background:#fff;color:var(--ink)}
@media(max-width:700px){.sortw{margin-left:0}}
.count{font-size:12px;color:var(--mut);margin:4px 0 0}
table.tr{width:100%;border-collapse:collapse;font-size:14px}
.tr th{text-align:left;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:700;padding:10px 10px 8px 0;border-bottom:1px solid #000;white-space:nowrap}
.tr th.r,.tr td.r{text-align:right}
.tr td{padding:11px 10px 11px 0;border-bottom:1px solid var(--rule);vertical-align:top}
.tr tr.hit td{background:#fffbea}
.tr tr.hit td:first-child{box-shadow:inset 3px 0 0 var(--holdb);padding-left:8px}
.who b{font-weight:600}
.who .sub{display:block;font-size:12px;color:var(--mut)}
.co{display:block;font-size:12.5px;color:var(--ink2);line-height:1.4;margin-top:4px;max-width:320px}
.co .own{color:var(--mut);font-size:11.5px}
.chip{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12px;font-weight:600;line-height:1;padding:4px 6px;border:1px solid var(--rule2);border-radius:2px;color:var(--ink);background:#fff;white-space:nowrap;display:inline-block}
.chip.h{background:var(--hold);border-color:var(--holdb);color:#3d2f00}
.chip.none{color:var(--mut2);font-weight:500}
.badge{display:inline-block;font-size:10px;line-height:1.2;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 5px;border-radius:2px;vertical-align:2px;margin-left:6px;white-space:nowrap}
.badge.vip{background:#000;color:#fff}
.badge.wl{background:var(--hold);color:#5a4500;border:1px solid var(--holdb)}
.badge.fmr{background:var(--off);color:var(--mut);border:1px solid var(--rule2)}
.dir{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px;white-space:nowrap}
.dir i{width:8px;height:8px;display:inline-block;border-radius:1px;background:currentColor}
.dir.buy{color:var(--up)}.dir.sell{color:var(--dn)}.dir.exchange{color:var(--mx)}.dir.other{color:var(--fl)}
.lag{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.lag.late{color:var(--dn)}
.lag small{display:block;font-family:var(--sans);font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:700}
.src a{color:var(--link);text-decoration:none;font-weight:500;font-size:13px;white-space:nowrap}
.src a:hover{text-decoration:underline}
.src .alt{display:block;font-size:11px;color:var(--mut2)}
.src .alt a{color:var(--mut);font-size:11px;font-weight:400}
.empty{padding:44px 0;text-align:center;color:var(--mut);border-bottom:1px solid var(--rule)}
.empty b{display:block;font-size:17px;color:var(--ink2);font-weight:600;margin-bottom:4px}
@media(max-width:759px){
 .tr thead{display:none}
 .tr,.tr tbody,.tr tr,.tr td{display:block;width:100%}
 .tr tr{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:14px 0;border-bottom:1px solid var(--rule)}
 .tr tr.hit{background:#fffbea;box-shadow:inset 3px 0 0 var(--holdb);padding-left:10px;padding-right:6px}
 .tr tr.hit td{background:none}
 .tr tr.hit td:first-child{box-shadow:none;padding-left:0}
 .edition h1 .zh{display:block;margin:4px 0 0}
 .tr td{border:0;padding:0}
 .tr td.r{text-align:left}
 .tr td[data-l]:before{content:attr(data-l);display:block;font-size:10px;letter-spacing:.12em;font-weight:700;color:var(--mut2);text-transform:uppercase}
 .tr td.c-who{grid-column:1/2}
 .tr td.c-filed{grid-column:2/3;grid-row:1;text-align:right}
 .tr td.c-asset{grid-column:1/-1}
 .tr td.c-meta{display:contents}
 .co{max-width:none}
}
.vipg{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 28px}
.vipc{padding:12px 0;border-bottom:1px solid var(--rule)}
.vipc .n{font-family:var(--serif);font-weight:700;font-size:17px}
.vipc .m{font-size:12px;color:var(--mut)}
.vipc .w{font-size:13px;color:var(--ink2);margin-top:6px;line-height:1.55}
.vipc .w b{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:700}
.vipc .st{display:inline-block;margin-top:6px;font-family:var(--mono);font-size:12px;font-weight:600;background:var(--off);border:1px solid var(--rule2);border-radius:2px;padding:2px 6px}
.vipc{scroll-margin-top:16px}.vipc:target{background:#fffbea;box-shadow:-10px 0 0 #fffbea,10px 0 0 #fffbea}
a.badge.vip{text-decoration:none}a.badge.vip:hover{background:#333}
.crit{font-size:13.5px;color:var(--ink2);line-height:1.65;max-width:860px;margin-bottom:6px}
.crit p{margin-bottom:6px}
.crit ul{padding-left:18px}.crit li{margin:2px 0}
.vipc .l{font-size:12px;color:var(--mut);margin-top:4px}
.vipc .l .num{color:var(--ink2)}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.wlg .k{font-size:10.5px;letter-spacing:.14em;font-weight:700;color:var(--mut);margin:10px 0 4px}
.note{font-size:12px;color:var(--mut);margin-top:10px;line-height:1.6}
.disc{margin-top:30px;padding:14px 16px;background:var(--off);border-left:2px solid #000;font-size:12.5px;color:var(--ink2);line-height:1.7}
.foot{margin:28px 0 40px;padding-top:12px;border-top:1px solid var(--rule);font-size:11.5px;color:var(--mut)}
.foot .row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.foot .srcs{margin-top:6px;line-height:1.7}
.foot .ok{color:var(--up)}.foot .bad{color:var(--dn)}
.psel{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut);font-weight:600;letter-spacing:.04em}
.psel select{font-weight:600;max-width:240px}
.more{display:block;margin:14px auto 0;font:600 13px var(--sans);background:#fff;color:var(--ink);border:1px solid var(--ink);border-radius:2px;padding:10px 18px;cursor:pointer}
.more:hover{background:#000;color:#fff}
.tkclear{font:600 12px var(--mono);background:var(--hold);border:1px solid var(--holdb);color:#3d2f00;border-radius:2px;padding:7px 10px;cursor:pointer}
.vipc{display:grid;grid-template-columns:76px 1fr;gap:0 14px;align-items:start}
.vipc .ph{width:76px;height:92px;object-fit:cover;border-radius:2px;background:var(--off);filter:grayscale(.15)}
.vipc .ph.ini{display:flex;align-items:center;justify-content:center;font:700 22px var(--serif);color:var(--mut)}
.vipc .go{display:inline-block;margin-top:6px;font-size:12px;color:var(--link);text-decoration:none;font-weight:600}
.vipc .go:hover{text-decoration:underline}
.tkg{display:flex;flex-wrap:wrap;gap:6px}
button.chip{cursor:pointer;font-size:12.5px;padding:6px 8px}
button.chip:hover{border-color:var(--ink)}
button.chip .c{color:var(--mut);font-weight:500;margin-left:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
"""

JS = r"""
(function(){
 var PAGE=10;
 var rows=[].slice.call(document.querySelectorAll('#rows tr[data-filed]'));
 var tbody=document.getElementById('rows'),empty=document.getElementById('empty'),count=document.getElementById('count');
 var more=document.getElementById('more'),pol=document.getElementById('pol'),tkc=document.getElementById('tkclear');
 var ref=new Date(document.body.getAttribute('data-today')+'T00:00:00Z');
 var st={who:'all',days:'30',buys:false,sort:'filed',p:'',tk:'',limit:PAGE};
 function age(d){return Math.round((ref-new Date(d+'T00:00:00Z'))/864e5)}
 function apply(keep){
  if(!keep)st.limit=PAGE;
  var key={filed:function(r){return r.dataset.filed+r.dataset.traded},traded:function(r){return r.dataset.traded+r.dataset.filed},lag:function(r){return ('00000'+(r.dataset.lag||0)).slice(-5)},size:function(r){return ('000000000000'+(r.dataset.size||0)).slice(-12)}}[st.sort];
  var sorted=rows.slice().sort(function(a,b){var x=key(a),y=key(b);return x<y?1:x>y?-1:0});
  var match=0;
  sorted.forEach(function(r){
   tbody.appendChild(r);
   var ok=(st.who==='all'||(st.who==='vip'&&r.dataset.vip==='1')||(st.who==='wl'&&r.dataset.wl==='1'))
    &&(!st.buys||r.dataset.tx==='Buy')&&(st.days==='all'||age(r.dataset.filed)<=+st.days)
    &&(!st.p||r.dataset.p===st.p)&&(!st.tk||r.dataset.tk===st.tk);
   if(ok)match++;
   r.hidden=!(ok&&match<=st.limit);
  });
  var shown=Math.min(match,st.limit),left=match-shown;
  empty.hidden=match>0;
  count.textContent=match?('Showing '+shown+' of '+match+' disclosures · yellow rows hit the Watchlist'):'';
  more.hidden=left<=0;
  more.textContent='Show '+Math.min(PAGE,left)+' more · '+left+' remaining';
  tkc.hidden=!st.tk;tkc.textContent='Ticker: '+st.tk+'  ✕';
 }
 document.querySelectorAll('[data-group]').forEach(function(g){
  g.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;
   g.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',x===b)});
   st[g.dataset.group]=b.dataset.v;apply();});
 });
 var tb=document.getElementById('buys');tb.addEventListener('click',function(){st.buys=!st.buys;tb.setAttribute('aria-pressed',st.buys);apply()});
 document.getElementById('sort').addEventListener('change',function(e){st.sort=e.target.value;apply()});
 pol.addEventListener('change',function(e){st.p=e.target.value;if(st.p)allDays();apply()});
 more.addEventListener('click',function(){st.limit+=PAGE;apply(true)});
 tkc.addEventListener('click',function(){st.tk='';apply()});
 function allDays(){
  var d=document.querySelector('[data-group=days]');
  if(st.days!=='all'){st.days='all';d.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',x.dataset.v==='all')})}
 }
 function pickTicker(tk){
  st.tk=tk;allDays();
  apply();document.getElementById('disclosures').scrollIntoView({behavior:'smooth'});
 }
 document.querySelectorAll('[data-pick]').forEach(function(b){b.addEventListener('click',function(){pickTicker(b.dataset.pick)})});
 document.querySelectorAll('.vipc[data-p]').forEach(function(c){c.querySelector('.go')&&c.querySelector('.go').addEventListener('click',function(e){e.preventDefault();pol.value=c.dataset.p;st.p=c.dataset.p;allDays();apply();document.getElementById('disclosures').scrollIntoView({behavior:'smooth'})})});
 apply();
})();
"""


def _e(s) -> str:
    return escape(str(s or ""), quote=True)


def _fmt_date(iso: str) -> str:
    d = parse_date(iso)
    return d.strftime("%Y-%m-%d") if d else "—"


def person_id(t: dict) -> str:
    return t.get("bioguide") or t.get("name") or ""


def _chamber_line(t: dict) -> str:
    bits = [t.get("chamber") or ""]
    ps = "-".join(b for b in [t.get("party") or "", t.get("state") or ""] if b)
    if ps:
        bits.append(ps)
    return " · ".join(b for b in bits if b)


def _row(t: dict, vips: dict | None = None) -> str:
    tx = t["tx"]
    tx_cls = {"Buy": "buy", "Sell": "sell", "Exchange": "exchange"}.get(tx, "other")
    lag = t.get("lag_days")
    late = lag is not None and lag > 45
    ticker = t.get("ticker") or ""
    chip_cls = "chip h" if t.get("watchlist") else "chip"
    ticker_html = f'<span class="{chip_cls}">{_e(display_ticker(ticker))}</span>' if ticker else '<span class="chip none">no ticker</span>'
    if t.get("watchlist"):
        sym = t.get("watchlist_symbol") or ticker
        label = "Watchlist" if display_ticker(sym) == display_ticker(ticker) else f"Watchlist · {display_ticker(sym)}"
        ticker_html += f'<span class="badge wl" title="On Adrian\'s Watchlist">{_e(label)}</span>'
    owner = t.get("owner") or ""
    owner_html = f' <span class="own">· {_e(owner)}</span>' if owner and owner.lower() not in {"self", "--"} else ""
    badges = ""
    if t.get("vip"):
        v = (vips or {}).get(t.get("bioguide"), {})
        tip = " — ".join(x for x in [v.get("stat"), v.get("why")] if x) or "On the VIP list"
        badges += f'<a class="badge vip" href="#vip-{_e(t.get("bioguide"))}" title="{_e(tip)}">VIP</a>'
    if t.get("former"):
        badges += '<span class="badge fmr">Former</span>'
    amended = (t.get("comment") or "").startswith("Amendment")
    lag_note = "<small>amended</small>" if amended else ("<small>late</small>" if late else "")
    alt = ""
    if t.get("alt_url") and t.get("alt_url") != t.get("source_url"):
        alt = f'<span class="alt"><a href="{_e(t["alt_url"])}" target="_blank" rel="noopener noreferrer">Quiver profile</a></span>'
    lag_html = "—" if lag is None else f"{lag}d{lag_note}"
    size_lo = band_min(t.get("amount", ""))
    return (
        f'<tr data-filed="{_e(t["filed_date"])}" data-traded="{_e(t["trade_date"])}" data-tx="{_e(tx)}" '
        f'data-p="{_e(person_id(t))}" data-tk="{_e(display_ticker(ticker))}" '
        f'data-vip="{1 if t.get("vip") else 0}" data-wl="{1 if t.get("watchlist") else 0}" '
        f'data-lag="{lag if lag is not None else ""}" data-size="{size_lo}"'
        f'{" class=hit" if t.get("watchlist") else ""}>'
        f'<td class="c-filed num" data-l="Filed">{_fmt_date(t["filed_date"])}</td>'
        f'<td class="c-who who"><b>{_e(t["name"])}</b>{badges}<span class="sub">{_e(_chamber_line(t))}</span></td>'
        f'<td class="c-asset">{ticker_html}<span class="co">{_e(t.get("company") or "—")}{owner_html}</span></td>'
        f'<td data-l="Type"><span class="dir {tx_cls}"><i></i>{_e(tx)}</span></td>'
        f'<td class="num" data-l="Size">{_e(t.get("amount"))}</td>'
        f'<td class="num" data-l="Traded">{_fmt_date(t["trade_date"])}</td>'
        f'<td class="r" data-l="Lag"><span class="lag{" late" if late else ""}" title="Filing date − trade date">{lag_html}</span></td>'
        f'<td class="src" data-l="Source"><a href="{_e(t["source_url"])}" target="_blank" rel="noopener noreferrer">{_e(t.get("source_label") or "Source")} ↗</a>{alt}</td>'
        "</tr>"
    )


def _stats(trades: list[dict], today: date) -> list[tuple[str, str, str, str]]:
    def within(days):
        lo = today - timedelta(days=days)
        return [t for t in trades if (parse_date(t["filed_date"]) or date.min) >= lo]

    w7, w30 = within(7), within(30)
    lags = [t["lag_days"] for t in w30 if t.get("lag_days") is not None]
    vips = {t["name"] for t in w30 if t.get("vip")}
    wl = [t for t in w30 if t.get("watchlist")]
    wl_syms = sorted({display_ticker(t.get("watchlist_symbol") or t.get("ticker")) for t in wl})
    return [
        ("New disclosures", "新披露", str(len(w7)), "last 7 days"),
        ("Watchlist hits", "持倉重疊", str(len(wl)), ", ".join(wl_syms[:5]) or "last 30 days"),
        ("VIPs active", "VIP 活躍", f"{len(vips)}", "of 10 · last 30 days"),
        ("Median lag", "披露延遲", f"{int(statistics.median(lags))}d" if lags else "—", "trade → filing · 30d"),
    ]


def render_page(cfg: dict, payload: dict, now: datetime) -> str:
    site = cfg["site"]
    trades = payload["trades"]
    today = now.date()
    canonical = f"{site['base_url']}/{site['path']}/"
    stamp = f"{now:%Y-%m-%d %H:%M} HKT"
    by_id: dict[str, list[dict]] = {}
    for t in trades:
        by_id.setdefault(person_id(t), []).append(t)

    vips = {v["bioguide"]: v for v in payload["vip"]}
    rows = "".join(_row(t, vips) for t in trades)
    stats = "".join(
        f'<div class="stat"><div class="k">{_e(k)}<span class="zh">{_e(zh)}</span></div><div class="v">{_e(v)}</div><div class="s">{_e(s)}</div></div>'
        for k, zh, v, s in _stats(trades, today)
    )

    vip_cards = []
    for v in payload["vip"]:
        mine = by_id.get(v["bioguide"], [])
        last = max((t["filed_date"] for t in mine), default="")
        fmr = '<span class="badge fmr">Former member</span>' if v.get("former") else ""
        last_html = (
            f'Last filing <span class="num">{_e(last)}</span> · <span class="num">{len(mine)}</span> rows in window'
            if last
            else "No disclosures in window"
        )
        initials = "".join(w[0] for w in v["name"].split()[:2])
        photo = (
            f'<img class="ph" src="{_e(v["photo"])}" alt="{_e(v["name"])}" loading="lazy" width="76" height="92">'
            if v.get("photo")
            else f'<div class="ph ini" aria-hidden="true">{_e(initials)}</div>'
        )
        go = f'<a class="go" href="#disclosures">See their disclosures →</a>' if mine else ""
        vip_cards.append(
            f'<div class="vipc" id="vip-{_e(v["bioguide"])}" data-p="{_e(v["bioguide"])}">{photo}<div>'
            f'<div class="n">{_e(v["name"])}{fmr}</div>'
            f'<div class="m">{_e(v["chamber"])} · {_e(v["party"])}-{_e(v["state"])}</div>'
            + (f'<div class="st">{_e(v["stat"])}</div>' if v.get("stat") else "")
            + f'<div class="w"><b>Why VIP</b>{_e(v.get("why"))}</div>'
            + f'<div class="l">{last_html}</div>{go}</div></div>'
        )

    crit = payload.get("vip_criteria") or {}
    crit_html = ""
    if crit:
        crit_html = (
            f'<div class="crit"><p>{_e(crit.get("summary"))}</p><ul>'
            + "".join(f"<li>{_e(r)}</li>" for r in crit.get("rules", []))
            + "</ul></div>"
        )

    tick_count: dict[str, list] = {}
    for t in trades:
        if t.get("ticker"):
            d = tick_count.setdefault(display_ticker(t["ticker"]), [0, False])
            d[0] += 1
            d[1] = d[1] or bool(t.get("watchlist"))
    tickers_html = "".join(
        f'<button class="chip{" h" if hit else ""}" data-pick="{_e(tk)}">{_e(tk)}<span class="c">{n}</span></button>'
        for tk, (n, hit) in sorted(tick_count.items(), key=lambda kv: (-kv[1][0], kv[0]))
    )

    people: dict[str, tuple[str, bool, int]] = {}
    for t in trades:
        pid = person_id(t)
        name, vip, n = people.get(pid, (t["name"], bool(t.get("vip")), 0))
        people[pid] = (name, vip, n + 1)
    def _opts(vip_flag: bool) -> str:
        items = sorted(((n, pid, c) for pid, (n, v, c) in people.items() if v == vip_flag), key=lambda x: x[0])
        return "".join(f'<option value="{_e(pid)}">{_e(n)} ({c})</option>' for n, pid, c in items)
    pol_html = (
        '<label class="psel" for="pol">Politician<select id="pol"><option value="">All politicians</option>'
        f'<optgroup label="VIP">{_opts(True)}</optgroup><optgroup label="Other members (Watchlist hits)">{_opts(False)}</optgroup>'
        "</select></label>"
    )

    stale = '<span class="stale">Data may be stale — sources unavailable at last build</span>' if payload.get("stale") else ""
    robots = '<meta name="robots" content="noindex,nofollow,noarchive">' if site.get("noindex") else ""
    empty_hidden = " hidden" if trades else ""
    weekday = WEEKDAYS[today.weekday()]

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
{robots}<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#000000">
<title>Politician Tracker · 政治人物持股動向 — ADRRR</title>
<meta name="description" content="STOCK Act disclosures from a VIP list of members of Congress, plus any trade that hits Adrian's Watchlist. Updated daily.">
<link rel="canonical" href="{_e(canonical)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@600;700;900&family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap">
<style>{CSS}</style></head>
<body data-today="{today.isoformat()}">
<header class="mast"><div class="wrap mast-in">
<a class="logo" href="{_e(site.get('home_url', '/'))}"><span class="en">ADRRR</span><span class="zh">政治人物持股動向</span></a>
<div class="mast-r"><span class="d">{today:%Y-%m-%d} · {weekday}</span><a href="{_e(site['archive_url'])}">Morning Report →</a></div>
</div></header>
<main class="wrap">
<section class="edition">
<div class="kicker">Trackers<span class="sep">/</span>追蹤器</div>
<h1>Politician Tracker<span class="zh">政治人物持股動向</span></h1>
<p class="dek">STOCK Act disclosures · VIP list + Watchlist overlap</p>
<div class="byl"><span>Updated <span class="num">{_e(stamp)}</span></span><span>Window since <span class="num">{_e(payload['window_start'])}</span></span><span>Sorted by newest disclosure</span><a href="#vip" class="whylink">Why these VIPs? ↓</a>{stale}</div>
</section>
<section class="stats" aria-label="Summary">{stats}</section>

<div class="sh" id="disclosures"><h2><span class="zh">最新披露</span>Disclosures</h2>{pol_html}</div>
<div class="bar" role="toolbar" aria-label="Filters">
 <div class="seg" data-group="who" role="group" aria-label="Who"><button data-v="all" aria-pressed="true">All</button><button data-v="vip" aria-pressed="false">VIP only</button><button data-v="wl" aria-pressed="false">Watchlist only</button></div>
 <button class="tog" id="buys" aria-pressed="false"><i></i>Buys only</button>
 <div class="seg" data-group="days" role="group" aria-label="Disclosed within"><button data-v="7" aria-pressed="false">7d</button><button data-v="30" aria-pressed="true">30d</button><button data-v="90" aria-pressed="false">90d</button><button data-v="all" aria-pressed="false">All</button></div>
 <button class="tkclear" id="tkclear" hidden></button>
 <label class="sortw" for="sort">Sort<select id="sort"><option value="filed">Newest disclosure</option><option value="traded">Newest trade</option><option value="lag">Longest lag</option><option value="size">Largest size</option></select></label>
</div>
<p class="count" id="count" aria-live="polite">{len(trades)} disclosures · rows highlighted yellow hit the Watchlist</p>
<table class="tr"><thead><tr><th>Filed</th><th>Politician</th><th>Ticker / Company</th><th>Type</th><th>Size</th><th>Traded</th><th class="r">Lag</th><th>Source</th></tr></thead>
<tbody id="rows">{rows}</tbody></table>
<button class="more" id="more" hidden>Show more</button>
<div class="empty" id="empty"{empty_hidden}><b>暫無 VIP／Watchlist 新披露</b>No new VIP or Watchlist disclosures for this filter.</div>

<div class="sh" id="vip"><h2><span class="zh">追蹤名單</span>Why these VIPs</h2><span class="aux">Track record and signal quality, not trade count · reviewed quarterly</span></div>
{crit_html}<div class="vipg">{''.join(vip_cards)}</div>

<div class="sh"><h2><span class="zh">涉及股票</span>Tickers in disclosures</h2><span class="aux">Number = disclosures in window · yellow = on your Watchlist · tap a ticker to filter</span></div>
<div class="tkg">{tickers_html or '<span class="note">No tickers yet.</span>'}</div>

<p class="disc">Disclosures are not investment advice. The STOCK Act allows members up to ~45 days to report a trade, so every row is delayed; <b>lag</b> = filing date − trade date, and rows over 45 days are marked late. Sizes are the statutory reporting bands, so any leaderboard returns cited here are estimates derived from those bands.</p>
<footer class="foot"><div class="row"><span>非投資建議。 Not investment advice.</span><span><a href="{_e(site['archive_url'])}">Morning Report archive</a> · <a href="/{_e(site['path'])}/data.json">data.json</a></span></div></footer>
</main>
<script>{JS}</script>
</body></html>
"""
