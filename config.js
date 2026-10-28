// Configuration for the Duplicate check panel plugin.
window.PLUGIN_CONFIG = {
  // Field with the checksum of the file as the user uploaded it.
  // Present in Assets 10 since SVL-1655 (2020). Verify on a recent asset.
  CHECKSUM_FIELD: 'firstExtractedChecksum',

  // Also match on capture date + time (IPTC/EXIF). Catches re-exported or
  // resized copies that have a different checksum.
  MATCH_CAPTURE_DATE: true,

  // Also match on identical file name. Weakest signal, shown as "Same file name".
  MATCH_FILENAME: true,

  // Candidate field names for the capture date, first one present wins.
  // VERIFY against your schema (Management Console > Metadata).
  CAPTURE_DATE_FIELDS: ['created', 'dateCreated', 'contentCreated', 'dateTimeOriginal'],

  // Ignore capture-date matches when the asset has no time part (00:00:00),
  // because "same day" alone gives too many false matches.
  REQUIRE_TIME_PART: true,

  // Max number of selected assets to check at once.
  MAX_SELECTION: 20,

  // Max hits per search.
  MAX_HITS: 50,

  // After an upload in the host finishes, check the newest assets of the
  // current user automatically (needs a username in the plugin context).
  AUTO_CHECK_AFTER_UPLOAD: true,
};
