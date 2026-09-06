import { TRAVEL_CLASSES, type AppConfig, type PassengerProfile, type TravelClass } from '@/types';
import { DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig } from '@/storage/storage-manager';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const GENDERS = ['', 'Male', 'Female', 'Other'];
const TYPES = ['Adult', 'Child'];

function fillClassSelect(select: HTMLSelectElement, includeBlank: boolean): void {
  select.innerHTML = '';
  if (includeBlank) select.append(new Option('— none —', ''));
  for (const token of TRAVEL_CLASSES) select.append(new Option(token, token));
}

function passengerCard(profile: PassengerProfile, index: number): HTMLElement {
  const card = document.createElement('div');
  card.className = 'passenger';

  const heading = document.createElement('h3');
  heading.textContent = `Passenger ${index + 1}`;

  const grid = document.createElement('div');
  grid.className = 'grid';

  const field = (labelText: string, node: HTMLElement): HTMLLabelElement => {
    const label = document.createElement('label');
    label.append(labelText, node);
    return label;
  };

  const name = document.createElement('input');
  name.type = 'text';
  name.id = `p${index}-name`;
  name.value = profile.name;
  name.placeholder = 'Full name as on ID';

  const age = document.createElement('input');
  age.type = 'text';
  age.id = `p${index}-age`;
  age.value = profile.age;
  age.placeholder = 'e.g. 27';

  const gender = document.createElement('select');
  gender.id = `p${index}-gender`;
  for (const value of GENDERS) gender.append(new Option(value || '— select —', value));
  gender.value = profile.gender;

  const type = document.createElement('select');
  type.id = `p${index}-type`;
  for (const value of TYPES) type.append(new Option(value, value));
  type.value = profile.passengerType || 'Adult';

  grid.append(
    field('Name', name),
    field('Age', age),
    field('Gender', gender),
    field('Type', type)
  );

  card.append(heading, grid);
  return card;
}

function render(config: AppConfig): void {
  $<HTMLInputElement>('from').value = config.journey.fromStation;
  $<HTMLInputElement>('to').value = config.journey.toStation;
  $<HTMLInputElement>('date').value = config.journey.dateISO;

  fillClassSelect($<HTMLSelectElement>('searchClass'), true);
  $<HTMLSelectElement>('searchClass').value = config.journey.searchClass;

  const trains = config.preferences.trainPriority;
  $<HTMLInputElement>('train1').value = trains[0] ?? '';
  $<HTMLInputElement>('train2').value = trains[1] ?? '';
  $<HTMLInputElement>('train3').value = trains[2] ?? '';

  for (const [i, id] of ['class1', 'class2', 'class3'].entries()) {
    const select = $<HTMLSelectElement>(id);
    fillClassSelect(select, true);
    select.value = config.preferences.classPriority[i] ?? '';
  }

  $<HTMLInputElement>('targetSeats').value = String(config.seatPolicy.targetSeats);
  $<HTMLSelectElement>('partial').value = config.seatPolicy.partial;
  $<HTMLInputElement>('preferredCoach').value = config.seatPolicy.preferredCoach;
  $<HTMLSelectElement>('coachSpread').value = config.seatPolicy.coachSpread;

  $<HTMLInputElement>('openTime').value = config.schedule.openTimeBST;
  $<HTMLInputElement>('offsetMs').value = String(config.schedule.offsetMs);
  $<HTMLInputElement>('maxEmptyRetries').value = String(config.schedule.maxEmptyRetries);
  $<HTMLInputElement>('emptyRetryGapMs').value = String(config.schedule.emptyRetryGapMs);
  $<HTMLInputElement>('allowClockFallback').checked = config.schedule.allowClockFallback;

  const container = $('passengers');
  container.innerHTML = '';
  config.passengers.forEach((profile, index) => container.append(passengerCard(profile, index)));
}

function collect(previous: AppConfig): AppConfig {
  const classPriority = ['class1', 'class2', 'class3']
    .map((id) => $<HTMLSelectElement>(id).value)
    .filter((value): value is TravelClass => value !== '');

  const passengers: PassengerProfile[] = previous.passengers.map((profile, index) => ({
    ...profile,
    name: $<HTMLInputElement>(`p${index}-name`).value.trim(),
    age: $<HTMLInputElement>(`p${index}-age`).value.trim(),
    gender: $<HTMLSelectElement>(`p${index}-gender`).value,
    passengerType: $<HTMLSelectElement>(`p${index}-type`).value,
  }));

  const seats = Number($<HTMLInputElement>('targetSeats').value);

  return {
    ...previous,
    journey: {
      fromStation: $<HTMLInputElement>('from').value.trim(),
      toStation: $<HTMLInputElement>('to').value.trim(),
      dateISO: $<HTMLInputElement>('date').value,
      searchClass: $<HTMLSelectElement>('searchClass').value as TravelClass | '',
    },
    preferences: {
      trainPriority: [
        $<HTMLInputElement>('train1').value.trim(),
        $<HTMLInputElement>('train2').value.trim(),
        $<HTMLInputElement>('train3').value.trim(),
      ],
      classPriority,
    },
    seatPolicy: {
      // Clamped, not merely validated: the extension never attempts more than 4.
      targetSeats: Math.min(4, Math.max(1, Number.isFinite(seats) ? seats : 4)),
      partial: $<HTMLSelectElement>('partial').value as AppConfig['seatPolicy']['partial'],
      // Coach codes are upper-case on the site; normalise so "kha" still matches.
      preferredCoach: $<HTMLInputElement>('preferredCoach').value.trim().toUpperCase(),
      coachSpread: $<HTMLSelectElement>('coachSpread').value as AppConfig['seatPolicy']['coachSpread'],
    },
    schedule: {
      ...previous.schedule,
      openTimeBST: $<HTMLInputElement>('openTime').value.trim() || DEFAULT_CONFIG.schedule.openTimeBST,
      offsetMs: Number($<HTMLInputElement>('offsetMs').value) || 0,
      // Clamped: a huge retry count with a tiny gap would become a refresh loop against the site.
      maxEmptyRetries: Math.min(30, Math.max(0, Number($<HTMLInputElement>('maxEmptyRetries').value) || 0)),
      emptyRetryGapMs: Math.max(150, Number($<HTMLInputElement>('emptyRetryGapMs').value) || 400),
      allowClockFallback: $<HTMLInputElement>('allowClockFallback').checked,
    },
    passengers,
  };
}

function showIssues(issues: Array<{ message: string }>): void {
  const box = $('issues');
  if (issues.length === 0) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML =
    '<strong>Saved, but these must be fixed before you can ARM:</strong><ul>' +
    issues.map((i) => `<li>${i.message.replace(/[<>&]/g, '')}</li>`).join('') +
    '</ul>';
}

void (async () => {
  let config = await loadConfig();
  render(config);

  $('save').addEventListener('click', async () => {
    config = collect(config);
    await saveConfig(config);
    render(config);

    const issues = validateConfig(config);
    showIssues(issues);

    const status = $('status');
    status.textContent = issues.length === 0 ? 'Saved — ready to arm' : 'Saved with warnings';
    window.setTimeout(() => (status.textContent = ''), 4000);
  });
})();
