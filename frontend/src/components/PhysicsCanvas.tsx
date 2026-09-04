// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { useEffect, useRef } from 'react';
import Matter from 'matter-js';
import type { Decision, TrajectoryEvent } from '../lib/types';

// Shown when no scenario is active; a running scenario narrows the canvas to
// its own tools (see the `tools` prop).
const ALL_TOOLS = [
  'get_account_balance',
  'transfer_funds',
  'purchase_item',
  'get_market_news',
  'read_market_research',
  'approve_trade',
  'execute_trade',
];
const TOOL_LABELS: Record<string, string> = {
  get_account_balance: 'balance lookup',
  transfer_funds: 'transfer funds',
  purchase_item: 'purchase item',
  get_market_news: 'market news',
  read_market_research: 'market research',
  approve_trade: 'approve trade',
  execute_trade: 'execute trade',
};

const COLORS: Record<Decision, string> = {
  ALLOW: '#22e584',
  DENY: '#ff3b5c',
  THROTTLED: '#ffb020',
  TOOL_ERROR: '#b96bff',
  ERROR: '#8ea0b5',
};

// In-flight color: the verdict is only revealed when the call reaches the
// wall, because that is where the decision actually happens.
const NEUTRAL = '#38bdf8';

const WALL_X_RATIO = 0.52;
const TOOL_X_RATIO = 0.86;
const CAT_WALL = 0x0002;
const CAT_BLOCKED = 0x0004;

interface Projectile {
  body: Matter.Body;
  decision: Decision;
  color: string; // current drawn color; starts NEUTRAL, revealed at the wall
  tool: string;
  toolY: number;
  revealed: boolean;
  arrived: boolean;
  bounced: boolean;
  bornAt: number;
  trail: { x: number; y: number }[];
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

interface Impact {
  y: number;
  at: number;
  color: string;
}

/** Physics scene: agent -> policy wall -> tools. Feed it played events. */
export function PhysicsCanvas({
  events,
  mode,
  tools,
}: {
  events: TrajectoryEvent[];
  mode: string;
  /** Tools to display for the active scenario; undefined shows all. */
  tools?: string[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seen = useRef(0);
  const scene = useRef<{
    engine: Matter.Engine;
    projectiles: Projectile[];
    sparks: Spark[];
    impacts: Impact[];
    toolList: string[];
    toolPulse: Record<string, { at: number; color: string }>;
    agentPulse: number;
  }>();

  // Initialize the physics world once.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = Matter.Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
    scene.current = {
      engine,
      projectiles: [],
      sparks: [],
      impacts: [],
      toolList: [...ALL_TOOLS],
      toolPulse: {},
      agentPulse: 0,
    };

    let raf = 0;
    let last = performance.now();

    const resize = () => {
      const parent = canvas.parentElement!;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = parent.clientWidth * dpr;
      canvas.height = parent.clientHeight * dpr;
      canvas.style.width = `${parent.clientWidth}px`;
      canvas.style.height = `${parent.clientHeight}px`;
      rebuildWall();
    };

    let wall: Matter.Body | null = null;
    const rebuildWall = () => {
      const s = scene.current!;
      if (wall) Matter.Composite.remove(s.engine.world, wall);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      wall = Matter.Bodies.rectangle(w * WALL_X_RATIO, h / 2, 14, h * 0.86, {
        isStatic: true,
        restitution: 0.9,
        collisionFilter: { category: CAT_WALL, mask: CAT_BLOCKED },
      });
      Matter.Composite.add(s.engine.world, wall);
    };

    Matter.Events.on(engine, 'collisionStart', (event) => {
      const s = scene.current!;
      for (const pair of event.pairs) {
        const bodies = [pair.bodyA, pair.bodyB];
        if (!wall || !bodies.includes(wall)) continue;
        const other = bodies.find((b) => b !== wall)!;
        const projectile = s.projectiles.find((p) => p.body === other);
        if (!projectile || projectile.bounced) continue;
        // The wall is where the verdict is revealed: flip to the decision
        // color at the moment of rejection, not before.
        projectile.bounced = true;
        projectile.revealed = true;
        projectile.color = COLORS[projectile.decision];
        s.impacts.push({ y: other.position.y, at: performance.now(), color: projectile.color });
        for (let i = 0; i < 22; i++) {
          const angle = Math.PI * (0.6 + Math.random() * 0.8); // spray back-left
          const speed = 2 + Math.random() * 5;
          s.sparks.push({
            x: other.position.x - 10,
            y: other.position.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed * (Math.random() > 0.5 ? 1 : -1),
            life: 1,
            color: projectile.color,
          });
        }
      }
    });

    const tick = (now: number) => {
      const s = scene.current!;
      const dt = Math.min(now - last, 50);
      last = now;
      Matter.Engine.update(s.engine, dt);
      draw(canvas, s, mode);
      raf = requestAnimationFrame(tick);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      Matter.Engine.clear(engine);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Narrow the tool column to the active scenario's tools.
  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.toolList = tools && tools.length > 0 ? [...tools] : [...ALL_TOOLS];
    s.toolPulse = {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools?.join('|')]);

  // Fire a projectile for every new verdict event.
  useEffect(() => {
    const s = scene.current;
    const canvas = canvasRef.current;
    if (!s || !canvas) return;
    // A new run resets the played-events list; reset the cursor with it,
    // otherwise no projectiles fire until a page refresh.
    if (events.length < seen.current) seen.current = 0;
    for (; seen.current < events.length; seen.current++) {
      const event = events[seen.current];
      if (event.kind === 'model_text' || event.kind === 'user_prompt') s.agentPulse = performance.now();
      if (event.kind !== 'verdict' || !event.tool || !event.decision) continue;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const shortTool = event.tool.split('___').pop() ?? event.tool;
      // Defensive: if the agent calls a tool the scenario did not declare,
      // add its node on the fly rather than mis-routing the projectile.
      let toolIndex = s.toolList.indexOf(shortTool);
      if (toolIndex === -1) {
        s.toolList.push(shortTool);
        toolIndex = s.toolList.length - 1;
      }
      const toolY = toolPosition(h, toolIndex, s.toolList.length);
      const start = { x: w * 0.14, y: h / 2 };
      const decision = event.decision;
      const blocked = decision === 'DENY' || decision === 'THROTTLED';

      const body = Matter.Bodies.circle(start.x, start.y, 7, {
        frictionAir: 0,
        restitution: 0.9,
        collisionFilter: {
          category: blocked ? CAT_BLOCKED : 0x0001,
          mask: blocked ? CAT_WALL : 0x0000,
        },
      });
      const target = { x: w * TOOL_X_RATIO, y: toolY };
      const speed = 5.2;
      const dx = target.x - start.x;
      const dy = target.y - start.y;
      const norm = Math.hypot(dx, dy);
      Matter.Body.setVelocity(body, { x: (dx / norm) * speed, y: (dy / norm) * speed });
      Matter.Composite.add(s.engine.world, body);
      s.projectiles.push({
        body,
        decision,
        color: NEUTRAL,
        tool: shortTool,
        toolY,
        revealed: false,
        arrived: false,
        bounced: false,
        bornAt: performance.now(),
        trail: [],
      });
    }
  }, [events]);

  return <canvas ref={canvasRef} className="physics-canvas" />;
}

function toolPosition(height: number, index: number, count: number): number {
  if (count <= 1) return height * 0.5;
  // Evenly spaced, vertically centered, with the gap capped so short lists
  // stay clustered around the middle instead of hugging the edges.
  const gap = Math.min((height * 0.68) / (count - 1), height * 0.22);
  const top = (height - gap * (count - 1)) / 2;
  return top + gap * index;
}

function draw(
  canvas: HTMLCanvasElement,
  s: {
    engine: Matter.Engine;
    projectiles: Projectile[];
    sparks: Spark[];
    impacts: Impact[];
    toolList: string[];
    toolPulse: Record<string, { at: number; color: string }>;
    agentPulse: number;
  },
  mode: string,
) {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const now = performance.now();
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.strokeStyle = 'rgba(56,189,248,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 36) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 36) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const wallX = w * WALL_X_RATIO;
  const logOnly = mode === 'LOG_ONLY';

  // Glass wall
  const wallTop = h * 0.07;
  const wallHeight = h * 0.86;
  const gradient = ctx.createLinearGradient(wallX - 10, 0, wallX + 10, 0);
  const base = logOnly ? '255,176,32' : '56,189,248';
  gradient.addColorStop(0, `rgba(${base},0.02)`);
  gradient.addColorStop(0.5, `rgba(${base},${logOnly ? 0.18 : 0.28})`);
  gradient.addColorStop(1, `rgba(${base},0.02)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(wallX - 10, wallTop, 20, wallHeight);
  ctx.strokeStyle = `rgba(${base},0.5)`;
  ctx.setLineDash(logOnly ? [8, 8] : []);
  ctx.strokeRect(wallX - 10, wallTop, 20, wallHeight);
  ctx.setLineDash([]);

  // Impact shimmers on the wall
  s.impacts = s.impacts.filter((impact) => now - impact.at < 700 && now - impact.at > -4000);
  for (const impact of s.impacts) {
    const age = (now - impact.at) / 700;
    if (age < 0 || age > 1) continue;
    const radius = 6 + age * 34;
    ctx.beginPath();
    ctx.arc(wallX, impact.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = impact.color + Math.floor((1 - age) * 160).toString(16).padStart(2, '0');
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Agent node
  const agentX = w * 0.14;
  const agentPulseAge = Math.min((now - s.agentPulse) / 900, 1);
  drawNode(ctx, agentX, h / 2, 26, '#38bdf8', 'AGENT', agentPulseAge < 1 ? 1 - agentPulseAge : 0);

  // Tool nodes (only the active scenario's tools)
  s.toolList.forEach((tool, i) => {
    const y = toolPosition(h, i, s.toolList.length);
    const pulse = s.toolPulse[tool];
    let glow = 0;
    let color = '#5eead4';
    if (pulse) {
      const age = (now - pulse.at) / 800;
      if (age > 0 && age < 1) {
        glow = 1 - age;
        color = pulse.color;
      }
    }
    drawNode(ctx, w * 0.86, y, 17, color, TOOL_LABELS[tool] ?? tool.replace(/_/g, ' '), glow);
  });

  // Projectiles + trails
  s.projectiles = s.projectiles.filter((p) => {
    const age = now - p.bornAt;
    const { x, y } = p.body.position;
    const expired = age > 6000 || x > w + 30 || x < -60 || y < -60 || y > h + 60 || (p.bounced && age > 2600);
    if (expired) {
      Matter.Composite.remove(s.engine.world, p.body);
      return false;
    }
    return true;
  });
  for (const p of s.projectiles) {
    const { x, y } = p.body.position;

    // Pass-through verdicts are revealed at the wall: the call was neutral
    // until the policy engine cleared it. (Blocked calls are revealed by the
    // collision handler at the same spot.)
    if (!p.revealed && x >= wallX - 8) {
      p.revealed = true;
      p.color = p.decision === 'ERROR' ? COLORS.ERROR : COLORS.ALLOW;
      s.impacts.push({ y, at: now, color: p.color });
    }
    // Arrival at the tool: pulse it. A TOOL_ERROR was allowed through the
    // wall; the failure belongs to the tool itself, so it turns purple here.
    if (!p.arrived && !p.bounced && x >= w * TOOL_X_RATIO - 14) {
      p.arrived = true;
      if (p.decision === 'TOOL_ERROR') p.color = COLORS.TOOL_ERROR;
      s.toolPulse[p.tool] = { at: now, color: p.color };
    }

    p.trail.push({ x, y });
    if (p.trail.length > 14) p.trail.shift();
    for (let i = 0; i < p.trail.length; i++) {
      const t = i / p.trail.length;
      ctx.beginPath();
      ctx.arc(p.trail[i].x, p.trail[i].y, 6 * t, 0, Math.PI * 2);
      ctx.fillStyle = p.color + Math.floor(t * 60).toString(16).padStart(2, '0');
      ctx.fill();
    }
    const fade = p.bounced ? Math.max(0, 1 - (now - p.bornAt - 1200) / 1400) : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(fade, 0.05);
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.restore();
  }

  // Sparks
  s.sparks = s.sparks.filter((spark) => spark.life > 0.02);
  for (const spark of s.sparks) {
    spark.x += spark.vx;
    spark.y += spark.vy;
    spark.vx *= 0.96;
    spark.vy *= 0.96;
    spark.life *= 0.94;
    ctx.beginPath();
    ctx.arc(spark.x, spark.y, 2.4 * spark.life, 0, Math.PI * 2);
    ctx.fillStyle = spark.color + Math.floor(spark.life * 220).toString(16).padStart(2, '0');
    ctx.fill();
  }

  // Wall label
  ctx.fillStyle = `rgba(${base},0.75)`;
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.save();
  ctx.translate(wallX, h * 0.045);
  ctx.fillText(logOnly ? 'POLICY ENGINE · LOG_ONLY' : 'POLICY ENGINE · ENFORCE', 0, 0);
  ctx.restore();

  ctx.restore();
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  label: string,
  glow: number,
) {
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 30 * glow;
  }
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10,20,35,0.9)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = 'rgba(226,240,255,0.85)';
  ctx.font = '600 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label.toUpperCase(), x, y + radius + 14);
}
