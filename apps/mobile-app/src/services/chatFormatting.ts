import type { ChatMessage } from '@loved-ones/shared';

export interface FormattedChatListItem {
  message: ChatMessage;
  isMine: boolean;
  showDateSeparator: boolean;
  dateLabel: string;
  showSenderHeader: boolean;
  compactTime: string;
  senderInitials: string;
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDayLabel(date: Date, now: Date): string {
  if (Number.isNaN(date.getTime())) return 'Recent';
  const target = dayKey(date);
  const today = dayKey(now);
  if (target === today) return 'Today';

  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (target === dayKey(yesterdayDate)) return 'Yesterday';

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatCompactTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function computeInitials(username: string): string {
  const parts = username.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

/**
 * Formats group chat messages with day dividers, grouped sender headers,
 * sent vs received flags, and compact local timestamps.
 */
export function groupChatMessagesForDisplay(
  messages: readonly ChatMessage[],
  currentUserId: string | null | undefined,
  now = new Date(),
): FormattedChatListItem[] {
  const items: FormattedChatListItem[] = [];
  let prevDayKey: string | null = null;
  let prevSenderId: string | null = null;

  for (const message of messages) {
    const createdDate = new Date(message.createdAt);
    const currentDay = Number.isNaN(createdDate.getTime()) ? 'invalid' : dayKey(createdDate);
    const showDateSeparator = prevDayKey !== currentDay;
    const isMine = Boolean(currentUserId && message.senderId === currentUserId);
    const showSenderHeader = !isMine && (showDateSeparator || prevSenderId !== message.senderId);

    items.push({
      message,
      isMine,
      showDateSeparator,
      dateLabel: formatDayLabel(createdDate, now),
      showSenderHeader,
      compactTime: formatCompactTime(createdDate),
      senderInitials: computeInitials(message.senderUsername || 'M'),
    });

    prevDayKey = currentDay;
    prevSenderId = message.senderId;
  }

  return items;
}
