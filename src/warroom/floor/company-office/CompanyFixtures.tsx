import type { ServerTierId } from "../../../domain/company/catalog.ts";
import { BUILDING, DATACENTRE_FRONT } from "../office.ts";
import { tokenColor } from "../tokens.ts";
import { useOfficePlan } from "./context.ts";
import type { OfficeRack } from "./plan.ts";

const RACK_HEIGHT = 2.1;
const POST = 0.04;
/** How tall each server tier sits in its rack: about 1U, 2U and 4U, so a bigger buy reads at a glance. */
const UNIT_HEIGHT: Readonly<Record<ServerTierId, number>> = { small: 0.09, medium: 0.18, large: 0.36 };
const UNIT_Y = 1.05;

/** What a company owns that the shared office doesn't: its racks, and a data centre shut until it buys a server room. */
export function CompanyFixtures() {
  const plan = useOfficePlan();
  if (plan.hasColleagues) return null;
  return (
    <>
      {plan.racks.map((rack) => (
        <OpenRack key={rack.key} rack={rack} />
      ))}
      {!plan.isDataCentreOpen && <ShutDataCentre />}
    </>
  );
}

/** An open-frame rack: four posts, and the server you bought glowing in it, or nothing yet. */
function OpenRack({ rack }: { rack: OfficeRack }) {
  const { footprint, server } = rack;
  const frame = tokenColor("--color-world-rack");
  const front = footprint.depth / 2;
  return (
    <group position={[footprint.x, 0, footprint.z]} rotation={[0, rack.front === 1 ? 0 : Math.PI, 0]}>
      {[-1, 1].flatMap((side) =>
        [-1, 1].map((end) => (
          <mesh key={`${side}${end}`} position={[side * (footprint.width / 2 - POST / 2), RACK_HEIGHT / 2, end * (front - POST / 2)]} castShadow>
            <boxGeometry args={[POST, RACK_HEIGHT, POST]} />
            <meshStandardMaterial color={frame} roughness={0.5} metalness={0.6} />
          </mesh>
        )),
      )}
      <mesh position={[0, RACK_HEIGHT - POST / 2, 0]}>
        <boxGeometry args={[footprint.width, POST, footprint.depth]} />
        <meshStandardMaterial color={frame} roughness={0.5} metalness={0.6} />
      </mesh>
      {server && <ServerUnit width={footprint.width - POST * 2} depth={footprint.depth - POST * 2} height={UNIT_HEIGHT[server]} front={front} />}
    </group>
  );
}

function ServerUnit({ width, depth, height, front }: { width: number; depth: number; height: number; front: number }) {
  return (
    <group position={[0, UNIT_Y + height / 2, 0]}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color={tokenColor("--color-world-metal")} roughness={0.4} metalness={0.7} />
      </mesh>
      {/* The front's status strip: green and steady, the server humming along. */}
      <mesh position={[width * 0.3, 0, front - 0.035]}>
        <planeGeometry args={[width * 0.25, Math.min(0.02, height * 0.3)]} />
        <meshStandardMaterial color={tokenColor("--color-good")} emissive={tokenColor("--color-good")} emissiveIntensity={1.4} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Dark glass over the data centre's front and its door: the hall is there, just not the company's yet. */
function ShutDataCentre() {
  const width = DATACENTRE_FRONT.toX - DATACENTRE_FRONT.fromX;
  return (
    <mesh position={[(DATACENTRE_FRONT.fromX + DATACENTRE_FRONT.toX) / 2, BUILDING.ceiling / 2, DATACENTRE_FRONT.z - 0.12]}>
      <planeGeometry args={[width, BUILDING.ceiling]} />
      <meshStandardMaterial color={tokenColor("--color-world-plastic")} transparent opacity={0.7} roughness={0.15} metalness={0.2} depthWrite={false} />
    </mesh>
  );
}
