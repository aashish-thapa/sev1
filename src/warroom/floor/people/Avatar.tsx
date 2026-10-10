import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { AnimationMixer, Frustum, Matrix4, Sphere, Vector3, type AnimationAction, type Group } from "three";
import type { AvatarId, ClipName } from "../assets/catalog.ts";
import { avatarUrl, clipsFor, clipUrls, cloneAvatar, hideHead, sexOf, STRIDE_SPEED } from "./avatars.ts";
import type { Motion } from "./behaviour.ts";
import type { Carried } from "../office.ts";
import { HandItem } from "./HandItem.tsx";

/** Draco is unused; meshopt decodes the geometry and animation buffers. */
const USE_DRACO = false;
const USE_MESHOPT = true;
const CROSSFADE_SECONDS = 0.3;
/** Beyond this nobody can read a gait; animate at half rate. */
const DETAIL_DISTANCE = 28;
// Per-frame scratch, reused by every avatar in turn.
const BODY = new Sphere(new Vector3(), 1.2);
const VIEW = new Frustum();
const VIEW_MATRIX = new Matrix4();

type Props = {
  id: AvatarId;
  /** Read every frame; the avatar blends to whatever it returns. */
  motion: () => Motion;
  /** The player's own body: no head, so the camera can sit at the eyes. */
  isFirstPerson?: boolean;
  /** Read every frame: what they have in their right hand, if anything. */
  carried?: () => Carried | null;
};

export function Avatar({ id, motion, isFirstPerson = false, carried }: Props) {
  const sex = sexOf(id);
  const avatar = useGLTF(avatarUrl(id), USE_DRACO, USE_MESHOPT);
  const takes = useGLTF(clipUrls(sex), USE_DRACO, USE_MESHOPT);
  const body = useMemo(() => {
    const copy = cloneAvatar(avatar.scene);
    if (isFirstPerson) hideHead(copy);
    return copy;
  }, [avatar.scene, isFirstPerson]);
  const clips = useMemo(() => clipsFor(takes.map((take) => take.animations), body), [takes, body]);
  const mixer = useMemo(() => new AnimationMixer(body), [body]);
  const group = useRef<Group>(null);
  const playing = useRef<{ clip: ClipName; action: AnimationAction } | null>(null);
  const pending = useRef({ seconds: 0, isOddFrame: false });

  useEffect(
    () => () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(body);
      // A remount (StrictMode, HMR) keeps this mixer; let the next frame start a fresh action.
      playing.current = null;
    },
    [mixer, body],
  );

  useFrame(({ camera }, delta) => {
    const root = group.current;
    if (!root) return;
    const wanted = motion();
    if (playing.current?.clip !== wanted.clip) {
      const clip = clips.get(wanted.clip);
      if (clip) {
        const next = mixer.clipAction(clip).reset().play();
        if (playing.current) next.crossFadeFrom(playing.current.action, CROSSFADE_SECONDS, true);
        playing.current = { clip: wanted.clip, action: next };
      }
    }
    if (playing.current) {
      const { clip, action } = playing.current;
      const stride = clip === "walk" || clip === "hurry" ? STRIDE_SPEED[sex][clip] : 0;
      action.timeScale = stride > 0 ? wanted.speed / stride : 1;
    }

    root.getWorldPosition(BODY.center);
    BODY.center.y += 0.9;
    VIEW.setFromProjectionMatrix(VIEW_MATRIX.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const isInView = VIEW.intersectsSphere(BODY);
    root.visible = isInView;
    // Off-screen and distant people still advance — just less often — so nobody pops when you turn.
    const isDetailed = isInView && BODY.center.distanceTo(camera.position) < DETAIL_DISTANCE;
    const clock = pending.current;
    clock.seconds += delta;
    clock.isOddFrame = !clock.isOddFrame;
    if (isDetailed || clock.isOddFrame) {
      mixer.update(clock.seconds);
      clock.seconds = 0;
    }
  });

  return (
    <group ref={group}>
      {/* Rocketbox rigs already face +Z, the floor's heading 0. */}
      <primitive object={body} />
      {carried && <HandItem body={body} carried={carried} />}
    </group>
  );
}
