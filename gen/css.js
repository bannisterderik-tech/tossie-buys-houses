export const CSS = ({ navy, navyDeep, navyInk, coral, coralDeep, ink, body, muted, line, wash, gold }) => `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;color:${body};background:#fff;font-size:17px;line-height:1.62;-webkit-font-smoothing:antialiased}
img{max-width:100%;height:auto;display:block}
a{color:${navy};text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,h4{color:${ink};line-height:1.16;margin:0 0 .5em;font-weight:800;letter-spacing:-.02em}
h1{font-size:clamp(2rem,5.2vw,3.4rem)}
h2{font-size:clamp(1.5rem,3.4vw,2.25rem);margin-top:0}
h3{font-size:clamp(1.15rem,2.2vw,1.4rem)}
p{margin:0 0 1.1em}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
.narrow{max-width:820px}

/* ---------- header ---------- */
.topbar{background:${navyInk};color:#dfe6f2;font-size:.82rem;letter-spacing:.02em}
.topbar .wrap{display:flex;gap:18px;align-items:center;justify-content:space-between;min-height:38px;flex-wrap:nowrap;white-space:nowrap;overflow:hidden}
.topbar a{color:#fff;font-weight:600}
.lic{opacity:.82}
header.site{position:sticky;top:0;z-index:60;background:#fff;border-bottom:1px solid ${line};box-shadow:0 1px 14px rgba(13,31,60,.06)}
header.site .wrap{display:flex;align-items:center;gap:18px;min-height:76px}
.logo{display:flex;align-items:center;gap:11px;font-weight:900;color:${navy};font-size:1.12rem;letter-spacing:-.02em;text-decoration:none;flex-shrink:0}
.logo img{height:52px;width:auto}
nav.main{margin-left:auto;display:flex;align-items:center;gap:22px}
nav.main a{color:${ink};font-weight:600;font-size:.94rem}
nav.main a:hover{color:${navy}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:${coral};color:#fff;font-weight:800;padding:13px 22px;border-radius:9px;border:0;cursor:pointer;font-size:1rem;line-height:1.2;text-align:center;transition:background .15s,transform .1s;box-shadow:0 2px 10px rgba(235,106,86,.32)}
.btn:hover{background:${coralDeep};text-decoration:none;color:#fff;transform:translateY(-1px)}
.btn-navy{background:${navy};box-shadow:0 2px 10px rgba(26,68,133,.28)}
.btn-navy:hover{background:${navyDeep}}
.btn-lg{padding:17px 32px;font-size:1.1rem;width:100%}
.btn-ghost{background:transparent;color:${navy};border:2px solid ${navy};box-shadow:none}
.btn-ghost:hover{background:${navy};color:#fff}
.navtoggle{display:none;margin-left:auto;background:none;border:1.5px solid ${line};border-radius:8px;padding:9px 12px;font-size:1.1rem;cursor:pointer;color:${ink}}

/* ---------- hero ---------- */
.hero{position:relative;background:${navyInk};color:#fff;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background-image:var(--hero);background-size:cover;background-position:center 60%;opacity:.62}
.hero::after{content:"";position:absolute;inset:0;background:linear-gradient(102deg,rgba(10,26,52,.93) 0%,rgba(10,26,52,.78) 38%,rgba(10,26,52,.34) 72%,rgba(10,26,52,.20) 100%)}
.hero .wrap{position:relative;z-index:2;display:grid;grid-template-columns:1.08fr .92fr;gap:46px;align-items:center;padding-top:60px;padding-bottom:60px}
.hero h1{color:#fff;margin-bottom:.36em;text-wrap:balance}
.hero .sub{font-size:1.2rem;color:#d6e0f0;margin-bottom:1.3em;max-width:38ch}
.eyebrow{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.26);color:#fff;font-size:.79rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;padding:7px 14px;border-radius:100px;margin-bottom:18px}
.herolist{list-style:none;padding:0;margin:0 0 26px;display:grid;gap:9px}
.herolist li{padding-left:29px;position:relative;color:#e8eef8;font-weight:600}
.herolist li::before{content:"";position:absolute;left:0;top:.42em;width:17px;height:17px;border-radius:50%;background:${coral};box-shadow:inset 0 0 0 3px rgba(255,255,255,.9)}
.herocta{display:flex;gap:13px;flex-wrap:wrap;align-items:center}
.phonebig{display:inline-flex;flex-direction:column;color:#fff;font-weight:800;font-size:1.3rem;letter-spacing:-.01em}
.phonebig small{display:block;font-size:.72rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#a9bcd8}

/* ---------- form ---------- */
.formcard{background:#fff;border-radius:15px;padding:28px;box-shadow:0 22px 60px rgba(0,0,0,.34);color:${body}}
.formcard h2{font-size:1.42rem;margin-bottom:.24em}
.formcard .fine{font-size:.86rem;color:${muted};margin-bottom:1.2em}
.field{margin-bottom:13px}
.field label{display:block;font-size:.83rem;font-weight:700;color:${ink};margin-bottom:5px}
.field input,.field select,.field textarea{width:100%;padding:13px 14px;border:1.5px solid ${line};border-radius:9px;font-size:1rem;font-family:inherit;color:${ink};background:#fff}
.field input:focus,.field select:focus,.field textarea:focus{outline:0;border-color:${navy};box-shadow:0 0 0 3px rgba(26,68,133,.14)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.consent{font-size:.71rem;color:${muted};line-height:1.5;margin-top:11px}
.consent a{color:${navy};text-decoration:underline}
.formnote{display:flex;align-items:center;gap:7px;justify-content:center;font-size:.83rem;color:${muted};margin-top:12px;font-weight:600}
.formstatus{margin-top:12px;padding:12px 14px;border-radius:9px;font-size:.92rem;font-weight:600;display:none}
.formstatus.ok{display:block;background:#e8f6ed;color:#15683a;border:1px solid #b6e0c6}
.formstatus.err{display:block;background:#fdecea;color:#a3261a;border:1px solid #f5c2bc}

/* ---------- sections ---------- */
section{padding:60px 0}
section.wash{background:${wash};border-top:1px solid ${line};border-bottom:1px solid ${line}}
.sechead{max-width:730px;margin-bottom:38px}
.sechead.center{margin-left:auto;margin-right:auto;text-align:center}
.kicker{font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${coral};margin-bottom:9px}

/* direct answer block — the AEO quote target */
.answer{background:linear-gradient(180deg,#fff,${wash});border:1px solid ${line};border-left:5px solid ${coral};border-radius:0 12px 12px 0;padding:24px 26px;margin:0 0 30px;font-size:1.08rem;line-height:1.68}
.answer strong{color:${ink}}
.answer .meta{display:block;margin-top:12px;font-size:.86rem;color:${muted};font-weight:600}

.trustbar{background:${navy};color:#fff;padding:0}
.trustbar .wrap{display:grid;grid-template-columns:repeat(4,1fr);gap:0}
.trustbar .t{padding:22px 18px;text-align:center;border-right:1px solid rgba(255,255,255,.16)}
.trustbar .t:last-child{border-right:0}
.trustbar b{display:block;font-size:1.45rem;font-weight:900;letter-spacing:-.02em}
.trustbar span{font-size:.81rem;color:#c3d2e8;font-weight:600}

.grid{display:grid;gap:20px}
.g2{grid-template-columns:repeat(2,1fr)}
.g3{grid-template-columns:repeat(3,1fr)}
.g4{grid-template-columns:repeat(4,1fr)}
.card{background:#fff;border:1px solid ${line};border-radius:13px;padding:26px;transition:box-shadow .17s,transform .17s,border-color .17s}
.card:hover{box-shadow:0 12px 34px rgba(13,31,60,.11);transform:translateY(-2px);border-color:#cdd8e8}
.card h3{margin-bottom:.4em}
.card p{font-size:.96rem;margin-bottom:.7em}
.card .more{font-weight:700;font-size:.92rem;color:${navy}}
.step{position:relative;padding-top:8px}
.stepnum{width:46px;height:46px;border-radius:50%;background:${navy};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.22rem;margin-bottom:14px}

/* comparison table */
.cmp{width:100%;border-collapse:separate;border-spacing:0;font-size:.96rem;border:1px solid ${line};border-radius:12px;overflow:hidden}
.cmp th,.cmp td{padding:15px 17px;text-align:left;border-bottom:1px solid ${line};vertical-align:top}
.cmp thead th{background:${navyInk};color:#fff;font-weight:800;font-size:.9rem;letter-spacing:.01em}
.cmp thead th.hi{background:${coral}}
.cmp tbody tr:last-child td{border-bottom:0}
.cmp td.hi{background:#fff6f4;font-weight:700;color:${ink}}
.cmp td:first-child{font-weight:700;color:${ink};background:${wash}}
.tablescroll{overflow-x:auto;-webkit-overflow-scrolling:touch}

/* faq */
.faq{border-top:1px solid ${line}}
.faq details{border-bottom:1px solid ${line}}
.faq summary{cursor:pointer;padding:19px 40px 19px 2px;font-weight:700;color:${ink};font-size:1.05rem;list-style:none;position:relative}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";position:absolute;right:8px;top:16px;font-size:1.6rem;font-weight:400;color:${coral};line-height:1}
.faq details[open] summary::after{content:"\\2212"}
.faq .a{padding:0 40px 20px 2px;color:${body};font-size:1rem}
.faq .a p:last-child{margin-bottom:0}

/* link clouds */
.links{display:flex;flex-wrap:wrap;gap:9px}
.links a{display:inline-block;background:#fff;border:1px solid ${line};border-radius:100px;padding:8px 15px;font-size:.88rem;font-weight:600;color:${ink}}
.links a:hover{background:${navy};color:#fff;border-color:${navy};text-decoration:none}
.colcloud{columns:3;column-gap:28px}
.colcloud a{display:block;padding:5px 0;font-size:.94rem;break-inside:avoid}

.crumbs{font-size:.84rem;color:${muted};padding:15px 0;border-bottom:1px solid ${line}}
.crumbs a{color:${muted};font-weight:600}
.crumbs a:hover{color:${navy}}
.crumbs span{margin:0 7px;opacity:.5}

.prose h2{margin-top:1.7em}
.prose h3{margin-top:1.5em}
.prose ul,.prose ol{margin:0 0 1.2em;padding-left:1.3em}
.prose li{margin-bottom:.45em}
.prose .callout{background:${wash};border:1px solid ${line};border-radius:12px;padding:22px 24px;margin:1.6em 0}
.prose .callout p:last-child{margin-bottom:0}
.prose .warn{background:#fffaf0;border-color:#f3dfae}
.srcs{font-size:.85rem;color:${muted};border-top:1px solid ${line};padding-top:16px;margin-top:30px}
.srcs a{color:${muted};text-decoration:underline}

.ctaband{background:${navy};color:#fff;text-align:center}
.ctaband h2{color:#fff}
.ctaband p{color:#cfdcf0;max-width:56ch;margin-left:auto;margin-right:auto;font-size:1.08rem}
.ctaband .herocta{justify-content:center;margin-top:22px}

footer.site{background:${navyInk};color:#a9bcd8;padding:52px 0 28px;font-size:.92rem}
footer.site h4{color:#fff;font-size:.86rem;letter-spacing:.1em;text-transform:uppercase;margin-bottom:14px}
footer.site a{color:#c9d6e8;display:block;padding:3px 0}
footer.site a:hover{color:#fff}
.footgrid{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:34px;margin-bottom:34px}
.footbot{border-top:1px solid rgba(255,255,255,.13);padding-top:20px;font-size:.83rem;line-height:1.7}
.footbot .disc{opacity:.72;max-width:78ch;margin-top:9px}

.mobilebar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:80;background:#fff;border-top:1px solid ${line};box-shadow:0 -3px 18px rgba(13,31,60,.14);padding:9px 12px;gap:9px}
.mobilebar a{flex:1;font-size:.97rem;padding:14px 8px}

@media(max-width:960px){
  .hero .wrap{grid-template-columns:1fr;gap:32px;padding-top:44px;padding-bottom:44px}
  .g4{grid-template-columns:repeat(2,1fr)}
  .footgrid{grid-template-columns:1fr 1fr}
  .colcloud{columns:2}
  .trustbar .wrap{grid-template-columns:repeat(2,1fr)}
  .trustbar .t:nth-child(2){border-right:0}
  .trustbar .t:nth-child(1),.trustbar .t:nth-child(2){border-bottom:1px solid rgba(255,255,255,.16)}
}
@media(max-width:1040px){
  body{padding-bottom:72px}
  nav.main{display:none;position:absolute;top:100%;left:0;right:0;background:#fff;flex-direction:column;align-items:stretch;gap:0;padding:8px 20px 18px;border-bottom:1px solid ${line};box-shadow:0 12px 26px rgba(13,31,60,.11)}
  nav.main.open{display:flex}
  nav.main a{padding:13px 0;border-bottom:1px solid ${line};font-size:1rem}
  nav.main .btn{margin-top:12px;border-bottom:0}
  .navtoggle{display:block}
  .mobilebar{display:flex}
}
@media(max-width:860px){
  .topbar .lic{display:none}
}
@media(max-width:760px){
  body{font-size:16.5px}
  section{padding:44px 0}
  .g2,.g3{grid-template-columns:1fr}
  .colcloud{columns:1}
  .formcard{padding:22px}
  .row2{grid-template-columns:1fr}
  .topbar .wrap{justify-content:center;gap:12px;font-size:.76rem}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
