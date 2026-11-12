import type { EstimateJob, Json } from '@/engine/estimate';

type Obj = { [key: string]: Json };

// The built-in sample jobs a preview prices (POST /api/prices/preview): small, made-up saved drafts
// with no customer, address or photo, so a preview shows an owner what their prices do before they
// publish. They are fixed in code, never read from a company's jobs. A preview prices a sample from
// the table it is given and writes nothing.

export type SampleJob = {
  id: string;
  name: string;
  summary: string;
  job: EstimateJob;
};

// A saved draft with the job-level counts that would price the equipment and call-out items.
function inspection(rooms: Obj[], changes: Obj = {}): EstimateJob {
  return {
    inspection: {
      address: '',
      year_built: 1995,
      rooms,
      emergency_calls: 1,
      haul_loads: 1,
      air_scrubbers: 0,
      hepa_filters: 0,
      monitoring_hours: 8,
      air_movers: 4,
      dehumidifiers: 1,
      drying_days: 3,
      scope_confirmed: true,
      ...changes,
    },
  };
}

export const SAMPLE_JOBS: readonly SampleJob[] = Object.freeze([
  {
    id: 'kitchen_cat1',
    name: 'Kitchen, Category 1',
    summary: 'A 150 sq ft kitchen with clean-water damage: 120 sq ft of flooring and 40 sq ft of drywall removed.',
    job: inspection([
      {
        name: 'Kitchen',
        category: 1,
        room_type_id: 'kitchen',
        water_class: 2,
        floor_sf: 150,
        wet_floor_sf: 150,
        unfinished_sf: 120,
        finished_sf: 40,
        ceiling_height_ft: 8,
      },
    ]),
  },
  {
    id: 'bathroom_cat3',
    name: 'Bathroom, Category 3',
    summary: 'A 60 sq ft bathroom with sewage damage and custom cabinetry: 60 sq ft of flooring, 90 sq ft of drywall.',
    job: inspection(
      [
        {
          name: 'Bathroom',
          category: 3,
          room_type_id: 'bathroom',
          water_class: 3,
          floor_sf: 60,
          wet_floor_sf: 60,
          unfinished_sf: 60,
          finished_sf: 90,
          custom_cabinetry: true,
          ceiling_height_ft: 8,
        },
      ],
      { air_movers: 3, hepa_filters: 1, air_scrubbers: 1 },
    ),
  },
  {
    id: 'three_rooms_cat2',
    name: 'Three rooms, Category 2',
    summary: 'A bedroom, a hallway and a living room with grey-water damage, 570 sq ft of floor in all.',
    job: inspection(
      [
        { name: 'Bedroom', category: 2, room_type_id: 'bedroom', water_class: 2, floor_sf: 180, wet_floor_sf: 180, unfinished_sf: 150, finished_sf: 30, ceiling_height_ft: 8 },
        { name: 'Hallway', category: 2, room_type_id: 'hallway', water_class: 2, floor_sf: 90, wet_floor_sf: 90, unfinished_sf: 70, finished_sf: 20, ceiling_height_ft: 8 },
        { name: 'Living room', category: 2, room_type_id: 'living_room', water_class: 2, floor_sf: 300, wet_floor_sf: 300, unfinished_sf: 250, finished_sf: 60, ceiling_height_ft: 9 },
      ],
      { air_movers: 8, dehumidifiers: 2 },
    ),
  },
  {
    id: 'bedroom_mold',
    name: 'Bedroom, mold',
    summary: 'A 140 sq ft bedroom marked Mold, S520 Condition 3, with 60 sq ft of growth.',
    job: inspection(
      [
        {
          name: 'Bedroom',
          category: 'mold',
          loss: 'mold',
          room_type_id: 'bedroom',
          floor_sf: 140,
          unfinished_sf: 60,
          finished_sf: 60,
          mold_condition: 3,
          affected_sf: 60,
          ceiling_height_ft: 8,
        },
      ],
      { air_movers: 0, dehumidifiers: 0, monitoring_hours: 0, haul_loads: 1, air_scrubbers: 1, hepa_filters: 2 },
    ),
  },
]);
