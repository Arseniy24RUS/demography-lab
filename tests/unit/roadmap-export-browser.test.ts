// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { downloadRoadmapVersion } from '../../apps/web/src/lib/roadmap-export';
import { makeRoadmapExportFixture } from './roadmap-export.fixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('roadmap download membership guard', () => {
  it('does not create a download after the authorized view loses its account context during preparation', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const version = await makeRoadmapExportFixture();
    const append = vi.spyOn(document.body, 'append');
    const canDownload = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await downloadRoadmapVersion(version, 'json', canDownload);
    expect(canDownload).toHaveBeenCalledTimes(2);
    expect(append).not.toHaveBeenCalled();
  });

  it('makes one explicit download and revokes its object URL after the navigation task', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const version = await makeRoadmapExportFixture();
    const create = vi.fn(() => 'blob:roadmap-test');
    const revoke = vi.fn();
    const originalUrl = URL;
    class TestURL extends originalUrl {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal('URL', TestURL);
    vi.useFakeTimers();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await downloadRoadmapVersion(version, 'json', () => true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000);
    expect(revoke).toHaveBeenCalledWith('blob:roadmap-test');
    expect(document.body.querySelector('a')).toBeNull();
  });
});
