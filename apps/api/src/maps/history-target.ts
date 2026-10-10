import { CONCEPTS } from "@gakushu-sochi/domain";
import type { LearningMapRepository } from "../repository/types.js";
import { loadUserConceptCatalog } from "./catalog.js";
import { MAX_MAPS_PER_USER, MAX_NODES_PER_MAP } from "../contract/learning-maps.js";

export interface HistoryConcept {
  id: string;
  label: string;
  summary: string;
  area: string;
  objectives: string[];
  fingerprint: string;
  needsObjectives?: boolean;
}

/** Current definitions only. Conflicting shared IDs are held, never merged. */
export async function loadHistoryTarget(
  maps: LearningMapRepository,
  userId: string,
  target: string,
) {
  const catalog = await loadUserConceptCatalog(maps, userId);
  const ownNodes = await maps.listOwnNodes(userId, MAX_MAPS_PER_USER * MAX_NODES_PER_MAP);
  const fixed = target.startsWith("language:");
  const language = target.slice("language:".length);
  const map = fixed ? null : await maps.get(userId, target);
  if (fixed ? !CONCEPTS.some((concept) => concept.language === language) : map === null)
    return null;
  const ids = fixed
    ? CONCEPTS.filter((concept) => concept.language === language).map((concept) => concept.id)
    : map!.nodes.map((node) => node.conceptId);
  const concepts: HistoryConcept[] = [];
  const warnings: string[] = [];
  for (const id of new Set(ids)) {
    const candidates = catalog.concepts.filter((concept) => concept.id === id);
    const definitions = candidates.map((concept) =>
      JSON.stringify([concept.label, concept.summary ?? ""]),
    );
    const objectives = catalog.objectives.filter((objective) => objective.conceptId === id);
    // Imported copies retain objective IDs. Different labels for the same ID are ambiguous.
    const objectiveLabels = new Map<string, string>();
    let conflict = new Set(definitions).size > 1;
    const ownDefinitions = ownNodes
      .filter((node) => node.conceptId === id)
      .map((node) =>
        JSON.stringify([
          node.label,
          node.summary,
          [...new Set(node.objectives.map((objective) => objective.label))].sort(),
        ]),
      );
    if (new Set(ownDefinitions).size > 1) conflict = true;
    for (const objective of objectives) {
      if (
        objectiveLabels.has(objective.id) &&
        objectiveLabels.get(objective.id) !== objective.label
      )
        conflict = true;
      objectiveLabels.set(objective.id, objective.label);
    }
    const concept = candidates[0];
    if (concept === undefined || conflict) {
      warnings.push(
        `${id}: ${conflict ? "同じ ID に異なる学習内容があるため保留" : "元の Concept が見つからないため保留"}`,
      );
      continue;
    }
    const definition = {
      id,
      label: concept.label,
      summary: concept.summary ?? "",
      area: fixed ? language : `${map!.title}: ${map!.description}`,
      objectives: [...new Set(objectiveLabels.values())].sort(),
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(definition)),
    );
    concepts.push({
      ...definition,
      fingerprint: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    });
  }
  return {
    target,
    concepts: await Promise.all(
      concepts.map(async (concept) => {
        const needsObjectives = concepts.some(
          (other) => other.id !== concept.id && other.label === concept.label,
        );
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify([concept.fingerprint, needsObjectives])),
        );
        return {
          ...concept,
          needsObjectives,
          fingerprint: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        };
      }),
    ),
    warnings,
  };
}
