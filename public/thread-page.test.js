import { describe, expect, it, vi } from 'vitest';
import {
  contributorPresentation,
  createCollaborationPoller,
  isJoinedViewer,
  publicThreadUrl,
  reconcileContributorBylines,
  shareThread,
  voteButtonLabel,
} from './thread-page.js';

describe('Jam sharing', () => {
  it('constructs a canonical public URL without query parameters or management fragments', () => {
    const capability = 'abcdefghijklmnopqrstuv';
    expect(publicThreadUrl('https://listen.cx/private?x=1#manage=secret', capability))
      .toBe(`https://listen.cx/t/${capability}`);
    expect(() => publicThreadUrl('https://listen.cx', 'not-a-capability')).toThrow('Invalid Jam capability');
  });

  it('uses the native share sheet before the clipboard', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    await expect(shareThread({
      title: 'Night drives',
      url: 'https://listen.cx/t/abcdefghijklmnopqrstuv',
      navigatorObject: { share, clipboard: { writeText } },
    })).resolves.toBe('shared');
    expect(share).toHaveBeenCalledWith({
      title: 'Night drives',
      text: 'Join “Night drives” on listen.cx',
      url: 'https://listen.cx/t/abcdefghijklmnopqrstuv',
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to clipboard and treats cancelling the share sheet as intentional', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(shareThread({
      title: 'Jam', url: 'https://listen.cx/t/abcdefghijklmnopqrstuv',
      navigatorObject: { share: vi.fn().mockRejectedValue(new Error('unavailable')), clipboard: { writeText } },
    })).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://listen.cx/t/abcdefghijklmnopqrstuv');

    const aborted = new Error('cancelled');
    aborted.name = 'AbortError';
    writeText.mockClear();
    await expect(shareThread({
      title: 'Jam', url: 'https://listen.cx/t/abcdefghijklmnopqrstuv',
      navigatorObject: { share: vi.fn().mockRejectedValue(aborted), clipboard: { writeText } },
    })).resolves.toBe('cancelled');
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('Jam participation and voting labels', () => {
  it('requires an actual joined participant even when the viewer is signed in', () => {
    expect(isJoinedViewer({ joined: true, signedIn: false })).toBe(true);
    expect(isJoinedViewer({ joined: false, signedIn: true })).toBe(false);
    expect(isJoinedViewer(null)).toBe(false);
  });

  it('describes vote direction, totals, and selected state', () => {
    expect(voteButtonLabel('Cataracts', 'up', 1)).toBe('Upvote Cataracts, 1 upvote');
    expect(voteButtonLabel('Cataracts', 'down', 2, true))
      .toBe('Remove your downvote from Cataracts, 2 downvotes');
  });
});

describe('live song attribution', () => {
  it('reconciles fresh contributor bylines independently of queue revision', () => {
    const row = { stable: true };
    const update = vi.fn();
    reconcileContributorBylines([
      { id: 4, addedBy: { displayName: 'Renamed friend', avatarUrl: 'https://images.example/friend.jpg' } },
    ], id => id === '4' ? row : null, update);

    expect(update).toHaveBeenCalledExactlyOnceWith(row, {
      displayName: 'Renamed friend',
      avatarUrl: 'https://images.example/friend.jpg',
    });
    expect(row).toEqual({ stable: true });
  });

  it('falls back to Guest and rejects unsafe contributor avatars', () => {
    expect(contributorPresentation({ addedBy: null })).toEqual({ displayName: 'Guest', avatarUrl: null });
    for (const avatarUrl of ['javascript:alert(1)', 'http://example.test/photo', 'https://user:secret@example.test/photo']) {
      expect(contributorPresentation({ addedBy: { displayName: '<Friend>', avatarUrl } }))
        .toEqual({ displayName: '<Friend>', avatarUrl: null });
    }
  });
});

describe('collaboration polling', () => {
  it('schedules recursively after completion and slows down while hidden', async () => {
    const scheduled = [];
    const cancelled = [];
    let visible = true;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const states = [];
    const poller = createCollaborationPoller({
      refresh,
      onState: state => states.push(state),
      isVisible: () => visible,
      schedule(callback, delay) { scheduled.push({ callback, delay }); return scheduled.length; },
      cancel: timer => cancelled.push(timer),
    });

    await poller.start();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['refreshing', 'live']);
    expect(scheduled.at(-1).delay).toBe(3000);

    visible = false;
    poller.visibilityChanged();
    expect(scheduled.at(-1).delay).toBe(30000);
    expect(cancelled).not.toHaveLength(0);
    poller.stop();
  });

  it('never overlaps refreshes and backs off after a failure', async () => {
    let finish;
    const schedule = vi.fn();
    const refresh = vi.fn(() => new Promise((resolve, reject) => { finish = { resolve, reject }; }));
    const states = [];
    const poller = createCollaborationPoller({
      refresh,
      onState: state => states.push(state),
      schedule,
      cancel: vi.fn(),
    });

    const first = poller.start();
    await poller.refresh();
    expect(refresh).toHaveBeenCalledTimes(1);
    finish.reject(new Error('offline'));
    await first;
    expect(states.at(-1)).toBe('stale');
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 6000);
    poller.stop();
  });
});
