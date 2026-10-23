// Buttondown signup shared by pages outside /news/. The Morning Report page is
// published separately and already has its own strip and end card.

export const NEWSLETTER = {
  subscribeUrl: 'https://buttondown.com/adrrr',
  action: 'https://buttondown.com/api/emails/embed-subscribe/adrrr',
  strip: '喜歡今日早報？每朝 9 點前免費送到你的信箱 →',
  eyebrow: 'ADRRR · NEWSLETTER',
  title: '每朝 9 點前，港美股早報直送信箱',
  body: 'ADRRR News Lab — 隔夜美股、港股盤前、經濟數據與異動股，5 分鐘掌握開市前重點。',
  button: '免費訂閱',
  fine: '免費 · 隨時取消 · 由 Buttondown 寄送',
  disclaimer: '本報僅供參考，不構成投資建議',
};

export function newsletterCardHtml() {
  const n = NEWSLETTER;
  return `<aside class="nl-card" id="newsletter" aria-labelledby="nl-heading">
  <div class="nl-card-in">
    <p class="nl-eye">${n.eyebrow}</p>
    <h2 id="nl-heading">${n.title}</h2>
    <p class="nl-lead">${n.body}</p>
    <form class="nl-form" action="${n.action}" method="post">
      <label class="nl-sr" for="nl-email">Email</label>
      <input id="nl-email" class="nl-email" type="email" name="email" required autocomplete="email" inputmode="email" maxlength="200" placeholder="Email" spellcheck="false">
      <input type="hidden" name="embed" value="1">
      <button type="submit">${n.button}</button>
    </form>
    <p class="nl-fine">免費 · 隨時取消 · 由 <a href="${n.subscribeUrl}">Buttondown</a> 寄送</p>
    <p class="nl-disc">${n.disclaimer}</p>
  </div>
</aside>`;
}

export function mountNewsletterCard(doc = globalThis.document) {
  if (!doc?.body || doc.body.dataset.newsletter === 'off') return;
  if (doc.getElementById('newsletter')) return;
  const footer = doc.querySelector('[data-site-footer]');
  if (!footer) return;
  const slot = doc.createElement('div');
  slot.className = 'nl-slot';
  slot.innerHTML = newsletterCardHtml();
  // Keep the card with the page content. body is a column flex and main grows,
  // so a card inserted before the footer sits in the leftover viewport gap.
  const main = doc.querySelector('main');
  if (main) main.append(slot);
  else footer.before(slot);
}
