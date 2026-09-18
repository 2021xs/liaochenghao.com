import { slugifyAll } from "./slugify";

export const BROWSE_CATEGORIES = [
  {
    label: "Engineering",
    metadataLabel: "Engineering",
    tag: "tech",
    tags: [
      "tech",
      "engineering",
      "backend",
      "distributed-systems",
      "database",
      "search",
      "algorithm",
      "architecture",
      "agent",
      "project",
      "research",
    ],
  },
  {
    label: "Projects",
    metadataLabel: "Project",
    tag: "project",
    tags: ["project"],
  },
  {
    label: "Interviews",
    metadataLabel: "Interview",
    tag: "interview",
    tags: ["interview", "career"],
  },
  {
    label: "Guides & Resources",
    metadataLabel: "Guide",
    tag: "guide",
    tags: ["guide"],
  },
  {
    label: "Thoughts",
    metadataLabel: "Thought",
    tag: "thought",
    tags: ["thought", "career"],
  },
] as const;

export const getBrowseCategories = (tags: string[]) => {
  const tagSlugs = new Set(slugifyAll(tags));

  return BROWSE_CATEGORIES.filter(category =>
    category.tags.some(tag => tagSlugs.has(tag))
  );
};

export const getBrowseCategory = (tag: string) =>
  BROWSE_CATEGORIES.find(category => category.tag === tag);
