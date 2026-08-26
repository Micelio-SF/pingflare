-- Keep existing Micelio status pages consistent with the English defaults.

UPDATE monitor_groups
SET description = 'Availability of Micelio public services.'
WHERE id = 'micelio-services';

UPDATE monitor_groups
SET
  name = 'External dependencies',
  slug = 'external-dependencies',
  description = 'Third-party services required to operate Micelio.'
WHERE id = 'micelio-dependencies';

UPDATE monitors
SET name = 'Micelio Public API', updated_at = datetime('now')
WHERE id = 'micelio-public-api';

UPDATE monitors
SET name = 'Micelio Website', updated_at = datetime('now')
WHERE id = 'micelio-web';

UPDATE monitors
SET name = 'SII', updated_at = datetime('now')
WHERE id = 'sii-landing';
