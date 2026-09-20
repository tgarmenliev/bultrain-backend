/**
 * Sections that still exist in the code but are switched off for now.
 * Nothing here is deleted — flip a flag to `true` to bring a section back.
 */
export const FEATURES = {
  /** Upload of a schedule ZIP archive on the overview screen (DataSync). */
  scheduleUpload: false,
  /** Holidays / schedule-exceptions screen (ExceptionsManager). */
  exceptions: false,
  /**
   * The old editor for the scraped schedules, including "update via JSON"
   * (TrainManager). Off = the trains screen shows the saved GTFS schedule.
   */
  legacyTrainEditor: false,
} as const;
