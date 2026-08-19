/**
 * FIXTURES ARE RECONSTRUCTIONS, NOT CAPTURED DOM.
 *
 * No HTML has been supplied for this site. These fixtures reproduce only what the supplied
 * screenshots actually establish: the visible text, the labels, the option strings, and the
 * presence or absence of the BOOK NOW button. Class names here are invented placeholders and
 * NOTHING in src/ is allowed to depend on them - that is the point of the exercise. The
 * parsers are text- and structure-driven, so these fixtures exercise the real logic.
 *
 * Replace these with genuine captured HTML as soon as it is available.
 */

/** A collapsed accordion row, as seen for MADHUMATI / BANALATA / PADMA. */
export function collapsedTrainRow(name: string, number: string): string {
  return `
    <div class="row">
      <div class="heading">${name} (${number})</div>
      <div class="counter">0+ users are trying to book ticket(s)</div>
    </div>`;
}

/** A class card. Passing seatsLeft > 0 renders BOOK NOW, matching the observed behaviour. */
export function classCard(name: string, fare: string, seatsLeft: number, vat = false): string {
  return `
    <div class="card">
      <div class="name">${name}</div>
      <div class="fare">৳${fare}</div>
      ${vat ? '<div class="vat">Including VAT</div>' : ''}
      <div class="avail">Available Tickets (Counter + Online)</div>
      <div class="count">${seatsLeft}</div>
      ${seatsLeft > 0 ? '<button class="book">BOOK NOW</button>' : ''}
    </div>`;
}

/** An expanded row: header, timings, then the class cards. */
export function expandedTrainRow(
  name: string,
  number: string,
  cards: string[],
  timings = { dep: '16 AUG, 11:20 PM', from: 'Rajshahi', arr: '17 AUG, 04:40 AM', to: 'Dhaka', dur: '05h 20m' }
): string {
  return `
    <div class="row">
      <div class="heading">${name} (${number})</div>
      <div class="counter">0+ users are trying to book ticket(s)</div>
      <div class="timings">
        <span>${timings.dep}</span><span>${timings.from}</span>
        <span>${timings.dur}</span>
        <span>${timings.arr}</span><span>${timings.to}</span>
        <a class="details">Train Details</a>
      </div>
      <div class="cards">${cards.join('')}</div>
    </div>`;
}

/** Results page shell, including the live counter that must not confuse the parser. */
export function resultsPage(rows: string[]): string {
  return `
    <div class="page">
      <div class="notice">Please Note: Other users may be in the process of purchasing tickets at this moment.</div>
      <div class="list">${rows.join('')}</div>
      <aside class="sidebar">Total Active Users on this page: 1</aside>
    </div>`;
}

/** Coach dropdown exactly as observed, counts embedded in the option text. */
export function coachSelect(
  coaches: Array<[string, number]> = [
    ['KHA', 0], ['GA', 0], ['GHA', 0], ['UMA', 0],
    ['CHA', 0], ['SCHA', 0], ['JA', 0], ['JHA', 2],
  ]
): string {
  const options = coaches
    .map(([code, seats]) => `<option value="${code}">${code} - ${seats} Seat(s)</option>`)
    .join('');
  return `<label>Select Coach</label><select id="coach">${options}</select>`;
}

/** Seat grid. `states` maps a seat number to a placeholder state class. */
export function seatGrid(coach: string, count: number, states: Record<number, string> = {}): string {
  const seats = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const state = states[n] ?? 'booked';
    return `<button class="seat ${state}">${coach}-${n}</button>`;
  }).join('');
  return `<div class="grid">${seats}</div>`;
}

export function seatLegend(): string {
  return `
    <div class="legend">
      <span class="sw available"></span><span>Available</span>
      <span class="sw selected"></span><span>Selected</span>
      <span class="sw progress"></span><span>In Progress</span>
      <span class="sw booked"></span><span>Booked</span>
    </div>`;
}
