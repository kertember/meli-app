// The notification texts, in Hungarian.

export type Reminder = {
  kind: 'reminder';
  user_id: string;
  id: number;
  day: string;
  hour: number;
  name: string;
  note: string;
  minutes_left: number;
};

export type Summary = {
  kind: 'summary';
  user_id: string;
  day: string;
  items: { hour: number; name: string; note: string }[];
};

export type Message = Reminder | Summary;

/** What the service worker shows. `url` opens the app on the day concerned. */
export type Notification = { title: string; body: string; tag: string; url: string };

export function notificationFor(message: Message): Notification {
  const url = `./?nap=${message.day}`;
  if (message.kind === 'reminder') {
    const when = message.minutes_left >= 59 ? '1 óra múlva' : `${Math.max(1, message.minutes_left)} perc múlva`;
    return {
      title: `${when}: ${message.name}`,
      body: `${message.hour}:00` + (message.note ? ` · ${message.note}` : ''),
      tag: `reminder-${message.id}`,
      url,
    };
  }
  return {
    title: 'Itt vannak a holnapi diákjaid.',
    body: message.items.map((i) => `${i.hour}:00 ${i.name}` + (i.note ? ` – ${i.note}` : '')).join('\n'),
    tag: `summary-${message.day}`,
    url,
  };
}
