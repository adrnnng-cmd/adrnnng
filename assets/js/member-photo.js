// Local portraits cached by the politician-tracker refresh.
// Every member, VIP or not, is /politician-tracker/img/<bioguide>.jpg.

export const MEMBER_PHOTO_PLACEHOLDER = '/politician-tracker/img/placeholder.svg';

const BIOGUIDE = /^[A-Z]\d{6}$/;

export function memberPhotoSrc(bioguide) {
  return BIOGUIDE.test(String(bioguide || '')) ? `/politician-tracker/img/${bioguide}.jpg` : '';
}

/** 56×70 door portrait. A missing bioguide or a 404 uses the neutral placeholder. */
export function memberPhotoImg(bioguide) {
  const src = memberPhotoSrc(bioguide) || MEMBER_PHOTO_PLACEHOLDER;
  return `<img src="${src}" alt="" width="56" height="70" onerror="this.onerror=null;this.src='${MEMBER_PHOTO_PLACEHOLDER}'">`;
}
