/** GET /api/admin/overview */
export interface Overview {
  trains: number;
  stations: number;
  guideTopics: number;
  gtfs: {
    hasData: boolean;
    tripsTotal: number;
    trainsTotal: number;
    from: string | null;
    to: string | null;
    daysLeft: number | null;
    feedVersion: string | null;
    importedAt: string | null;
    importStatus: string | null;
  };
  today: { date: string; trains: number };
  content: { ideasPublished: number; ideasDraft: number };
  delays: { trainsObserved: number; avgDelayMin: number } | null;
  realtime: {
    trips: number;
    vehicles: number;
    tripFresh: boolean;
    vehicleFresh: boolean;
    tripFeedTs: number | null;
    vehicleFeedTs: number | null;
  } | null;
  tracking: {
    armed: number;
    started: number;
    devices: number;
    devicesIos: number;
    devicesAndroid: number;
  } | null;
}

/** One row of GET /api/admin/gtfs/trains */
export interface GtfsTrainRow {
  trainNumber: string;
  categories: string[];
  from: string | null;
  to: string | null;
  departs: string | null;
  arrives: string | null;
  arrivesDay: number;
  stops: number;
  legs: number;
}

export interface GtfsTrainList {
  date: string;
  range: { from: string; to: string } | null;
  hasData: boolean;
  trains: GtfsTrainRow[];
}

export interface GtfsStop {
  seq: number;
  station: string | null;
  mapped: boolean;
  arrive: string | null;
  depart: string | null;
  arriveDay: number;
  departDay: number;
}

/** GET /api/admin/gtfs/trains/:trainNo */
export interface GtfsTrainDetail {
  trainNumber: string;
  date: string;
  legs: { tripId: string; category: string; stops: GtfsStop[] }[];
}
