"""Run the same randomized inspections through base and head claims engines; print JSON results."""
import sys, json, random
root = sys.argv[1]
sys.path.insert(0, root)
from backend.claims import price_scope, proposal_range, make_documents
from backend.contracts import InspectionData, AIResult
rng = random.Random(1978)
out = []
for i in range(300):
    rooms = [dict(name=f'Room {j}', category=rng.choice([1,2,3]), unfinished_sf=rng.choice([0, rng.uniform(0,900)]),
                  finished_sf=rng.choice([0, rng.uniform(0,1200)]), custom_cabinetry=rng.random()<.3,
                  waste_percent=rng.choice([0,5,10,15])) for j in range(rng.randint(1,4))]
    d = InspectionData(address='123 Test St, Bakersfield CA', year_built=rng.choice([None,1950,1977,1978,2005]),
        has_crawl_space=rng.random()<.5, granite_removal=rng.random()<.5, water_heater_loss=rng.random()<.5,
        rooms=rooms, air_movers=rng.randint(0,8), dehumidifiers=rng.randint(0,3), drying_days=rng.randint(1,7),
        labor_hours=rng.choice([0,2.5,8]), is_after_hours=rng.random()<.4, matterport_scans=rng.randint(0,2),
        dump_truck_loads=rng.randint(0,2), equipment_decon=rng.randint(0,3), power_distribution=rng.randint(0,2),
        wood_floor_systems=rng.randint(0,2), scope_confirmed=True)
    rec = {}
    try:
        items, total = price_scope(d); rec['items'] = items; rec['total'] = total
        rec['range'] = [str(v) for v in proposal_range(d, items)]
        docs = make_documents(d, [], AIResult(summary='Reviewed', suggestions=[], unpriced_work=[]))
        rec['docs'] = docs.model_dump(mode='json') if hasattr(docs,'model_dump') else docs
    except Exception as e:
        rec['error'] = f'{type(e).__name__}: {e}'
    out.append(rec)
print(json.dumps(out, sort_keys=True, default=str))
