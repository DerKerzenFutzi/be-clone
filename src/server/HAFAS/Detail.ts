import { addIrisMessagesToDetails } from 'server/journeys/journeyDetails';
import { AllowedHafasProfile } from 'types/HAFAS';
import { isAfter } from 'date-fns';
import createCtxRecon from 'server/HAFAS/helper/createCtxRecon';
import JourneyDetails from 'server/HAFAS/JourneyDetails';
import JourneyMatch from 'server/HAFAS/JourneyMatch';
import searchOnTrip from './SearchOnTrip';
import type { ParsedJourneyMatchResponse } from 'types/HAFAS/JourneyMatch';
import type { ParsedSearchOnTripResponse } from 'types/HAFAS/SearchOnTrip';
import type { Route$JourneySegmentTrain, Route$Stop } from 'types/routing';

export function calculateCurrentStopPlace(
  segment: ParsedSearchOnTripResponse,
  currentStopId?: string,
): Route$Stop | undefined {
  const currentDate = Date.now();
  let currentStop;

  if (currentStopId) {
    currentStop = segment.stops.find((s) => s.station.id === currentStopId);
  }

  if (!currentStop) {
    currentStop = segment.stops.find((s) => {
      const stopInfo = s.departure || s.arrival;

      return (
        stopInfo && !stopInfo.cancelled && isAfter(stopInfo.time, currentDate)
      );
    });
  }

  return currentStop;
}

export default async (
  trainName: string,
  currentStopId?: string,
  station?: string,
  date: Date = new Date(),
  plainDetails = false,
  hafasProfile: AllowedHafasProfile = AllowedHafasProfile.DB,
): Promise<ParsedSearchOnTripResponse | undefined> => {
  let possibleTrains: undefined | ParsedJourneyMatchResponse[];

  if (station) {
    try {
      possibleTrains = await JourneyMatch(
        {
          trainName,
          initialDepartureDate: date,
          jnyFltrL: [
            {
              type: 'STATIONS',
              mode: 'INC',
              value: station,
            },
          ],
        },
        hafasProfile,
      );
    } catch {
      // ignore
    }
  }

  if (!possibleTrains) {
    possibleTrains = await JourneyMatch(
      {
        trainName,
        initialDepartureDate: date,
      },
      hafasProfile,
    );
  }

  // possibleTrains.sort(t1 =>
  //   t1.firstStop.station.id.startsWith('80') ||
  //   t1.lastStop.station.id.startsWith('80')
  //     ? -1
  //     : 1
  // );
  const train: ParsedJourneyMatchResponse | undefined = possibleTrains[0];

  if (!train) return undefined;

  const journeyDetails = await JourneyDetails(train.jid, hafasProfile);

  if (!journeyDetails) return undefined;

  let relevantSegment: ParsedSearchOnTripResponse = {
    type: 'JNY',
    cancelled: journeyDetails.stops.every((s) => s.cancelled),
    finalDestination: journeyDetails.lastStop.station.title,
    jid: train.jid,
    train: journeyDetails.train,
    segmentDestination: journeyDetails.lastStop.station,
    segmentStart: journeyDetails.firstStop.station,
    stops: journeyDetails.stops,
    messages: journeyDetails.messages,
    arrival: journeyDetails.lastStop.arrival,
    departure: journeyDetails.firstStop.departure,
    polyline: journeyDetails.polylines?.[0],
  };
  if (plainDetails) {
    return relevantSegment;
  }

  try {
    const route = await searchOnTrip(
      {
        ctxRecon: createCtxRecon({
          firstStop: journeyDetails.firstStop,
          lastStop: journeyDetails.lastStop,
          trainName: journeyDetails.train.name,
          messages: journeyDetails.messages,
        }),
        sotMode: 'RC',
      },
      hafasProfile,
    );

    relevantSegment = route.segments.find(
      (s) => s.type === 'JNY',
    ) as Route$JourneySegmentTrain;
  } catch {
    // we keep using the JourneyDetailsOne
  }

  if (relevantSegment.stops.length !== journeyDetails.stops.length) {
    for (const [index, stop] of journeyDetails.stops.entries()) {
      if (stop.additional) {
        relevantSegment.stops.splice(index, 0, stop);
      }
    }
  }

  const lastStop = relevantSegment.stops
    .filter((s) => s.arrival && !s.arrival.cancelled)
    .pop();

  if (currentStopId) {
    relevantSegment.currentStop = relevantSegment.stops.find(
      (s) => s.station.id === currentStopId,
    );
  }

  if (!lastStop || !lastStop.arrival || lastStop.arrival.delay == null) {
    for (const [index, stop] of relevantSegment.stops.entries()) {
      const jDetailStop = journeyDetails.stops[index];

      if (jDetailStop.station.id !== stop.station.id) continue;
      if (jDetailStop.arrival && stop.arrival) {
        stop.arrival.delay = jDetailStop.arrival.delay;
        stop.arrival.time = jDetailStop.arrival.time;
      }
      if (jDetailStop.departure && stop.departure) {
        stop.departure.delay = jDetailStop.departure.delay;
        stop.departure.time = jDetailStop.departure.time;
      }
    }
  }

  relevantSegment.currentStop = calculateCurrentStopPlace(
    relevantSegment,
    currentStopId,
  );

  await addIrisMessagesToDetails(relevantSegment);

  return relevantSegment;
};
