import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, SearchResult, PlayRecord } from "@/services/api";
import type { AggFilters, AggFilterGroup, AggVideoItem } from "@/services/api";
import { EMPTY_AGG_FILTERS } from "@/services/api";
import { PlayRecordManager } from "@/services/storage";
import useAuthStore from "./authStore";
import { useSettingsStore } from "./settingsStore";

// AggFilters / AggFilterGroup 的唯一定义在 services/api.ts，
// 这里只做类型再导出，供 app/index.tsx 直接从 homeStore 引用，避免循环导入。
export type { AggFilters, AggFilterGroup };
export { EMPTY_AGG_FILTERS };

export type RowItem = (SearchResult | PlayRecord) & {
  id: string;
  source: string;
  title: string;
  poster: string;
  progress?: number;
  play_time?: number;
  lastPlayed?: number;
  episodeIndex?: number;
  sourceName?: string;
  totalEpisodes?: number;
  year?: string;
  rate?: string;
};

export interface Category {
  title: string;
  type?: "movie" | "tv" | "record";
  tag?: string;
  tags?: string[];
  // 仅 CMS 分类用；不填 = 豆瓣模式（现有行为不变）。
  // cmsType 与 tag/tags 互斥：进入 CMS 分类时 tag 不再生效，
  // 回到豆瓣分类时 filters 不再生效（见 selectCategory 的切换处理）。
  cmsType?: 1 | 2 | 3 | 4; // agg 的 t：1 电影、2 电视剧、3 动漫、4 综艺
  filters?: AggFilters; // 当前筛选，全空 = 不筛选
  filterOptions?: AggFilterGroup[]; // agg 返回的 filters，原样存入，供 UI 渲染，不得硬编码
  cmsFallback?: boolean; // 本次是否已回落到豆瓣（仅用于 UI 提示，不进缓存 key）
}

const initialCategories: Category[] = [
  { title: "最近播放", type: "record" },
  { title: "热门剧集", type: "tv", tag: "热门" },
  { title: "电视剧", type: "tv", tags: ["国产剧", "美剧", "英剧", "韩剧", "日剧", "港剧", "日本动画", "动画"], cmsType: 2, filters: { ...EMPTY_AGG_FILTERS } },
  {
    title: "电影",
    type: "movie",
    tags: [
      "热门",
      "最新",
      "经典",
      "豆瓣高分",
      "冷门佳片",
      "华语",
      "欧美",
      "韩国",
      "日本",
      "动作",
      "喜剧",
      "爱情",
      "科幻",
      "悬疑",
      "恐怖",
    ],
    cmsType: 1,
    filters: { ...EMPTY_AGG_FILTERS },
  },
  { title: "动漫", type: "tv", cmsType: 3, filters: { ...EMPTY_AGG_FILTERS } },
  { title: "综艺", type: "tv", cmsType: 4, filters: { ...EMPTY_AGG_FILTERS } },
  { title: "豆瓣 Top250", type: "movie", tag: "top250" },
];

// CMS 回落用的豆瓣 tag：agg 失败或无筛选空列表时用它回落豆瓣，
// 不清空用户筛选、不写 CMS 缓存。电影/电视剧的回落 tag 与其 tags[0] 一致，
// 动漫/综艺在 CMS 化后已无 tags/tag，故用这张固定映射表，不得再从 tags 里猜。
const getCmsFallbackTag = (category: Category): string => {
  switch (category.title) {
    case "电影":
      return "热门";
    case "电视剧":
      return "国产剧";
    case "动漫":
      return "日本动画";
    case "综艺":
      return "综艺";
    default:
      return category.tags?.[0] || category.tag || "热门";
  }
};

// 2026-11-05 筛选重做：按 CMS 分类记忆筛选。
// 记忆键是 cmsType（1 电影、2 电视剧、3 动漫、4 综艺），不是标题，
// 避免标题改动导致记忆失效。存 AsyncStorage，不进缓存 key，
// 不影响 agg 请求参数（仍是 6 维透传）。保存失败只吞错，
// 不阻塞筛选本身——最坏情况是重启后记忆丢失，回到默认。
export interface CmsFilterMemory {
  filters: AggFilters;
  filterOptions?: AggFilterGroup[];
  filtersVisible?: boolean;
}
export type CmsFilterMemoryMap = Partial<Record<number, CmsFilterMemory>>;
const FILTER_MEMORY_KEY = "oriontv:cmsFilterMemory:v1";
const FILTER_KEYS: (keyof AggFilters)[] = ["cate", "area", "year", "lang", "score", "order"];
const isValidCmsType = (v: unknown): v is 1 | 2 | 3 | 4 =>
  v === 1 || v === 2 || v === 3 || v === 4;
const sanitizeFilters = (v: unknown): AggFilters => {
  const src = (v || {}) as Partial<AggFilters>;
  const out = { ...EMPTY_AGG_FILTERS };
  for (const k of FILTER_KEYS) {
    if (typeof src[k] === "string") out[k] = src[k] as string;
  }
  return out;
};
const saveFilterMemory = (memory: CmsFilterMemoryMap): void => {
  AsyncStorage.setItem(FILTER_MEMORY_KEY, JSON.stringify(memory)).catch(() => {
    // 记忆丢失不是筛选失败，不抛错、不写 error 状态。
  });
};
const loadFilterMemory = async (): Promise<CmsFilterMemoryMap> => {
  try {
    const raw = await AsyncStorage.getItem(FILTER_MEMORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: CmsFilterMemoryMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      const cmsType = Number(k);
      if (!isValidCmsType(cmsType) || !v || typeof v !== "object") continue;
      const entry = v as Partial<CmsFilterMemory>;
      out[cmsType] = {
        filters: sanitizeFilters(entry.filters),
        filterOptions: Array.isArray(entry.filterOptions) ? entry.filterOptions : undefined,
        filtersVisible: typeof entry.filtersVisible === "boolean" ? entry.filtersVisible : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
};

// agg 项 -> RowItem（在 homeStore 做映射，不在 api.ts 混入 UI 类型）。
// source 保留 "agg"：VideoCard 点进详情时走 title 搜索，
// detailStore 已实测：preferredSource 失败/回 0 时会自动回落全量标题搜索，
// 因此本次不动 detailStore。若未来 detailStore 改掉回落，再改用 source 置空。
const mapAggItem = (item: AggVideoItem): RowItem => {
  return {
    id: item.vod_id,
    source: "agg",
    title: item.vod_name,
    poster: item.vod_pic || "",
    year: item.vod_year || "",
    rate: item.vod_douban_score && item.vod_douban_score !== "0.0" ? item.vod_douban_score : "",
    sourceName: item.type_name || "",
  } as unknown as RowItem;
};

// 添加缓存项接口
interface CacheItem {
  data: RowItem[];
  timestamp: number;
  type: 'movie' | 'tv' | 'record';
  hasMore: boolean;
  // 仅 CMS 分支用：翻页时从缓存页数继续，不得把缓存的 40 条当成“已加载全部”。
  pagecount?: number;
  aggPage?: number;
}

const CACHE_EXPIRE_TIME = 5 * 60 * 1000; // 5分钟过期
const MAX_CACHE_SIZE = 10; // 最大缓存容量
const MAX_ITEMS_PER_CACHE = 40; // 每个缓存最大条目数

const getCacheKey = (category: Category) => {
  if (category.cmsType) {
    const f = category.filters || EMPTY_AGG_FILTERS;
    return `cms-${category.cmsType}-${category.title}-c=${f.cate}|a=${f.area}|y=${f.year}|l=${f.lang}|s=${f.score}|o=${f.order}`;
  }
  return `${category.type || 'unknown'}-${category.title}-${category.tag || ''}`;
};

// filterOptions / cmsFallback 不进缓存 key：前者是 UI 选项，后者是过程标志，
// 否则同一筛选组合会因选项/回落状态不同而反复失效。

const isValidCache = (cacheItem: CacheItem) => {
  return Date.now() - cacheItem.timestamp < CACHE_EXPIRE_TIME;
};

interface HomeState {
  categories: Category[];
  selectedCategory: Category;
  contentData: RowItem[];
  loading: boolean;
  loadingMore: boolean;
  pageStart: number;
  // agg 分页专用：1-based 页码，首屏未加载为 0；不得复用豆瓣的 pageStart（offset 语义）。
  aggPage: number;
  hasMore: boolean;
  error: string | null;
  fetchInitialData: () => Promise<void>;
  loadMoreData: () => Promise<void>;
  selectCategory: (category: Category) => void;
  // CMS 筛选动作：仅当 selectedCategory.cmsType 存在时生效；
  // 语义与 selectCategory 一致（清空 + 重查），且内部直接调 fetchInitialData，
  // index.tsx 的 effect 对 CMS 模式不重复触发（见 index.tsx 注释），避免一次筛选发两次请求。
  setAggFilters: (filters: Partial<AggFilters>) => Promise<void>;
  clearAggFilters: () => Promise<void>;
  // 2026-11-05 筛选重做：待应用草稿。UI 点选项只改 pending，不发请求；
  // 点“应用”时 applyPendingFilters 一次性把 pending 写成已应用并重查，
  // 连选多组只发 1 次请求。pending 为 null 时 UI 应把它当成已应用值。
  pendingFilters: AggFilters | null;
  setPendingFilter: (key: keyof AggFilters, value: string) => void;
  applyPendingFilters: () => Promise<void>;
  discardPendingFilters: () => void;
  // 单组清除：立即生效（点叉就是明确的清除动作，不是连选），
  // 与组内点选项（只改草稿）语义分开，见 index.tsx 注释。
  clearAggFilterGroup: (key: keyof AggFilters) => Promise<void>;
  // 按 cmsType 记忆的筛选，见文件顶部 CmsFilterMemory 注释。
  cmsFilterMemory: CmsFilterMemoryMap;
  restoreFilterMemory: () => Promise<void>;
  // 首屏 agg 失败才为 true：此时 UI 必须写“筛选服务不可用，已显示豆瓣内容”，
  // 不能只写“已回落豆瓣”让用户以为还在筛 CMS。agg 成功后清零；
  // 无筛选空列表回落不是服务失败，本字段保持 false。
  filterServiceUnavailable: boolean;
  // 1.4.1 筛选栏可见性：纯 UI 状态，默认 false（隐藏），与筛选值、缓存 key、
  // 分页、回落逻辑完全无关。非 CMS 分类不渲染开关，故该值在非 CMS 下无意义；
  // 切换分类时由 selectCategory 重置为 false（点到新类目又是隐藏的）。
  // 筛选值变化（setAggFilters / clearAggFilters）不得改动它：选完不自动收起。
  filtersVisible: boolean;
  toggleFilters: () => void;
  setFiltersVisible: (visible: boolean) => void;
  refreshPlayRecords: () => Promise<void>;
  clearError: () => void;
}

// 内存缓存，应用生命周期内有效
const dataCache = new Map<string, CacheItem>();

const useHomeStore = create<HomeState>((set, get) => ({
  categories: initialCategories,
  selectedCategory: initialCategories[0],
  contentData: [],
  loading: true,
  loadingMore: false,
  pageStart: 0,
  aggPage: 0,
  hasMore: true,
  error: null,
  // 2026-11-05：CMS 分类默认展开筛选（不再默认隐藏）；非 CMS 分类
  // 不渲染筛选开关，本值无意义。记忆恢复后以记忆的可见性为准。
  filtersVisible: true,
  pendingFilters: null,
  cmsFilterMemory: {},
  filterServiceUnavailable: false,

  fetchInitialData: async () => {
    const { apiBaseUrl } = useSettingsStore.getState();
    await useAuthStore.getState().checkLoginStatus(apiBaseUrl);

    const { selectedCategory } = get();
    const cacheKey = getCacheKey(selectedCategory);

    // 最近播放不缓存，始终实时获取
    if (selectedCategory.type === 'record') {
      set({ loading: true, contentData: [], pageStart: 0, aggPage: 0, hasMore: true, error: null });
      await get().loadMoreData();
      return;
    }

    // 检查缓存
    if (dataCache.has(cacheKey) && isValidCache(dataCache.get(cacheKey)!)) {
      const cachedData = dataCache.get(cacheKey)!;
      set({
        loading: false,
        contentData: cachedData.data,
        pageStart: cachedData.data.length,
        aggPage: selectedCategory.cmsType ? (cachedData.aggPage ?? 1) : 0,
        hasMore: cachedData.hasMore,
        error: null
      });
      return;
    }

    set({ loading: true, contentData: [], pageStart: 0, aggPage: 0, hasMore: true, error: null });
    await get().loadMoreData();
  },

  loadMoreData: async () => {
    const { selectedCategory, pageStart, aggPage, loadingMore, hasMore } = get();
    if (loadingMore || !hasMore) return;

    if (selectedCategory.cmsType ? aggPage > 0 : pageStart > 0) {
      set({ loadingMore: true });
    }

    try {
      if (selectedCategory.type === "record") {
        const { isLoggedIn } = useAuthStore.getState();
        if (!isLoggedIn) {
          set({ contentData: [], hasMore: false });
          return;
        }
        const records = await PlayRecordManager.getAll();
        const rowItems = Object.entries(records)
          .map(([key, record]) => {
            const [source, id] = key.split("+");
            return {
              ...record,
              id,
              source,
              progress: record.play_time / record.total_time,
              poster: record.cover,
              sourceName: record.source_name,
              episodeIndex: record.index,
              totalEpisodes: record.total_episodes,
              lastPlayed: record.save_time,
              play_time: record.play_time,
            };
          })
          // .filter((record) => record.progress !== undefined && record.progress > 0 && record.progress < 1)
          .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));

        set({ contentData: rowItems, hasMore: false });
      } else if (selectedCategory.cmsType) {
        // CMS 分支必须放在豆瓣分支之前：CMS 分类同时残留 type 字段，
        // 判断顺序决定走哪条路；tag 在 CMS 模式下不生效（见 setAggFilters）。
        const cmsType = selectedCategory.cmsType;
        const filters = selectedCategory.filters || EMPTY_AGG_FILTERS;
        const nextPg = (get().aggPage || 0) + 1;
        const isFiltered = Object.values(filters).some((v) => !!v);

        // 回落豆瓣：仅首屏（nextPg === 1）回落；翻页失败不回落、不清空已有列表，
        // 直接抛到外层 catch 显示错误。回落不写 CMS 缓存、不清空用户筛选。
        const fallbackToDouban = async () => {
          const cat = get().selectedCategory;
          const fallbackType = cat.type === "movie" ? "movie" : "tv";
          const fallbackTag = getCmsFallbackTag(cat);
          const doubanResult = await api.getDoubanData(fallbackType, fallbackTag, 20, 0);
          const doubanItems = doubanResult.list.map((item) => ({
            ...item,
            id: item.title,
            source: "douban",
          })) as RowItem[];
          set({
            selectedCategory: { ...cat, cmsFallback: true },
            contentData: doubanItems,
            pageStart: doubanItems.length,
            aggPage: 0,
            hasMore: doubanResult.list.length !== 0,
            error: null,
          });
        };

        let result;
        try {
          result = await api.getAggCategory(cmsType, nextPg, filters);
        } catch (aggError) {
          if (nextPg === 1) {
            // 首屏 agg 失败：先记服务不可用，再回落豆瓣，UI 才能区分
            // “服务挂了”与“无筛选空列表回落”两种情况。
            set({ filterServiceUnavailable: true });
            await fallbackToDouban();
            return;
          }
          throw aggError;
        }
        // agg 成功但无筛选却空列表 = 异常（CMS 大类按 agg 设计“宁可多不可空”），走回落；
        // 有筛选的真实空结果不回落，显示“该筛选下暂无内容”（index.tsx 的空文案）。
        if (result.list.length === 0 && !isFiltered && nextPg === 1) {
          await fallbackToDouban();
          return;
        }

        const newItems = result.list.map(mapAggItem);
        const cacheKey = getCacheKey(selectedCategory);
        const updatedCategory: Category = result.filters
          ? { ...selectedCategory, filterOptions: result.filters, cmsFallback: false }
          : selectedCategory;
        set({ filterServiceUnavailable: false });
        // agg 成功即服务可用；filterOptions 写入时一并把记忆同步到
        // 当前 CMS 分类（选项本身不进缓存 key，只进记忆，供切回时直接渲染）。
        if (nextPg === 1) {
          const mem = { ...(get().cmsFilterMemory || {}) };
          if (selectedCategory.cmsType) {
            mem[selectedCategory.cmsType] = {
              filters: { ...(selectedCategory.filters || EMPTY_AGG_FILTERS) },
              filterOptions: updatedCategory.filterOptions,
              filtersVisible: get().filtersVisible,
            };
            saveFilterMemory(mem);
            set({ cmsFilterMemory: mem });
          }
        }
        const nextHasMore = nextPg < result.pagecount;

        if (nextPg === 1) {
          for (const [key, value] of dataCache.entries()) {
            if (!isValidCache(value)) {
              dataCache.delete(key);
            }
          }
          if (dataCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = Array.from(dataCache.keys())[0];
            dataCache.delete(oldestKey);
          }
          dataCache.set(cacheKey, {
            data: newItems.slice(0, MAX_ITEMS_PER_CACHE),
            timestamp: Date.now(),
            type: selectedCategory.type || 'tv',
            hasMore: nextHasMore,
            pagecount: result.pagecount,
            aggPage: 1,
          });
          set({
            selectedCategory: updatedCategory,
            contentData: newItems,
            pageStart: newItems.length,
            aggPage: 1,
            hasMore: nextHasMore,
          });
        } else {
          const existingCache = dataCache.get(cacheKey);
          if (existingCache && existingCache.data.length < MAX_ITEMS_PER_CACHE) {
            dataCache.set(cacheKey, {
              ...existingCache,
              data: [...existingCache.data, ...newItems].slice(0, MAX_ITEMS_PER_CACHE),
              hasMore: nextHasMore,
              pagecount: result.pagecount,
              aggPage: nextPg,
            });
          }
          set((state) => {
            // 2026-11-02 筛选/翻页去重：服务端改为按请求页码轮换上游站（筛选深分页的前提），
            // 同一部影片可能在不同页由不同站返回（vod_id 前缀不同、片名相同），
            // 追加时按片名去重，网格不再出现重复卡片。
            const seen = new Set<string>();
            for (const it of state.contentData) {
              const k = String(it.title || "").trim().toLowerCase();
              if (k) seen.add(k);
            }
            const deduped = newItems.filter((it) => {
              const k = String(it.title || "").trim().toLowerCase();
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            return {
              selectedCategory: updatedCategory,
              contentData: [...state.contentData, ...deduped],
              pageStart: state.pageStart + deduped.length,
              aggPage: nextPg,
              hasMore: nextHasMore,
            };
          });
        }
      } else if (selectedCategory.type && selectedCategory.tag) {
        const result = await api.getDoubanData(
          selectedCategory.type,
          selectedCategory.tag,
          20,
          pageStart
        );

        const newItems = result.list.map((item) => ({
          ...item,
          id: item.title,
          source: "douban",
        })) as RowItem[];

        const cacheKey = getCacheKey(selectedCategory);

        if (pageStart === 0) {
          // 清理过期缓存
          for (const [key, value] of dataCache.entries()) {
            if (!isValidCache(value)) {
              dataCache.delete(key);
            }
          }

          // 如果缓存太大，删除最旧的项
          if (dataCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = Array.from(dataCache.keys())[0];
            dataCache.delete(oldestKey);
          }

          // 限制缓存的数据条目数，但不限制显示的数据
          const cacheItems = newItems.slice(0, MAX_ITEMS_PER_CACHE);

          // 存储新缓存
          dataCache.set(cacheKey, {
            data: cacheItems,
            timestamp: Date.now(),
            type: selectedCategory.type,
            hasMore: true // 始终为 true，因为我们允许继续加载
          });

          set({
            contentData: newItems, // 使用完整的新数据
            pageStart: newItems.length,
            hasMore: result.list.length !== 0,
          });
        } else {
          // 增量加载时更新缓存
          const existingCache = dataCache.get(cacheKey);
          if (existingCache) {
            // 只有当缓存数据少于最大限制时才更新缓存
            if (existingCache.data.length < MAX_ITEMS_PER_CACHE) {
              const updatedData = [...existingCache.data, ...newItems];
              const limitedCacheData = updatedData.slice(0, MAX_ITEMS_PER_CACHE);

              dataCache.set(cacheKey, {
                ...existingCache,
                data: limitedCacheData,
                hasMore: true // 始终为 true，因为我们允许继续加载
              });
            }
          }

          // 更新状态时使用所有数据
          set((state) => ({
            contentData: [...state.contentData, ...newItems],
            pageStart: state.pageStart + newItems.length,
            hasMore: result.list.length !== 0,
          }));
        }
      } else if (selectedCategory.tags) {
        // It's a container category, do not load content, but clear current content
        set({ contentData: [], hasMore: false });
      } else {
        set({ hasMore: false });
      }
    } catch (err: any) {
      let errorMessage = "加载失败，请重试";

      if (err.message === "API_URL_NOT_SET") {
        errorMessage = "请点击右上角设置按钮，配置您的服务器地址";
      } else if (err.message === "UNAUTHORIZED") {
        // 会话超时：API 层已尝试自动重登并重试，仍失败说明重登也没成功，
        // 此时才提示用户重新登录（登录框由 restoreSession 弹出）。
        errorMessage = "认证失败，请重新登录";
      } else if (err.message.includes("Network")) {
        errorMessage = "网络连接失败，请检查网络连接";
      } else if (err.message.includes("timeout")) {
        errorMessage = "请求超时，请检查网络或服务器状态";
      } else if (err.message.includes("404")) {
        errorMessage = "服务器API路径不正确，请检查服务器配置";
      } else if (err.message.includes("500")) {
        errorMessage = "服务器内部错误，请联系管理员";
      } else if (err.message.includes("403")) {
        errorMessage = "访问被拒绝，请检查权限设置";
      }

      set({ error: errorMessage });
    } finally {
      set({ loading: false, loadingMore: false });
    }
  },

  selectCategory: (category: Category) => {
    const currentCategory = get().selectedCategory;
    // 2026-11-05：离开 CMS 分类前先保存它的记忆（筛选 + 选项 + 可见性），
    // 进入目标分类时再恢复目标分类的记忆，不再用初始 EMPTY 覆盖。
    // 记忆与 categories 列表分开存：categories 仍是初始列表，selectedCategory
    // 才是带记忆的当前对象；切换判定仍用标题/tag/cmsType，不用 filters，
    // 否则恢复后的 filters 与传入的 EMPTY 不等会误判为“筛选变化”而死循环。
    const memoryBefore = { ...(get().cmsFilterMemory || {}) };
    if (currentCategory.cmsType) {
      memoryBefore[currentCategory.cmsType] = {
        filters: { ...(currentCategory.filters || EMPTY_AGG_FILTERS) },
        filterOptions: currentCategory.filterOptions,
        filtersVisible: get().filtersVisible,
      };
    }
    const targetMemory = category.cmsType ? memoryBefore[category.cmsType] : undefined;
    const restoredCategory: Category = targetMemory
      ? {
          ...category,
          filters: { ...targetMemory.filters },
          filterOptions: targetMemory.filterOptions ?? category.filterOptions,
          cmsFallback: false,
        }
      : category;
    const targetVisible = targetMemory?.filtersVisible ?? (category.cmsType ? true : false);
    const targetPending = restoredCategory.filters
      ? { ...restoredCategory.filters }
      : null;

    if (currentCategory.title !== category.title || currentCategory.tag !== category.tag || currentCategory.cmsType !== category.cmsType) {
      set({
        cmsFilterMemory: memoryBefore,
        selectedCategory: restoredCategory,
        pendingFilters: targetPending,
        contentData: [],
        pageStart: 0,
        aggPage: 0,
        hasMore: true,
        error: null,
        filtersVisible: targetVisible,
        filterServiceUnavailable: false,
      });
      if (currentCategory.cmsType) saveFilterMemory(memoryBefore);

      if (category.type === 'record') {
        get().fetchInitialData();
        return;
      }

      const cacheKey = getCacheKey(restoredCategory);
      const cachedData = dataCache.get(cacheKey);
      if (cachedData && isValidCache(cachedData)) {
        set({
          contentData: cachedData.data,
          pageStart: cachedData.data.length,
          aggPage: category.cmsType ? (cachedData.aggPage ?? 1) : 0,
          hasMore: cachedData.hasMore,
          loading: false
        });
      } else {
        if (cachedData) {
          dataCache.delete(cacheKey);
        }
        get().fetchInitialData();
      }
    }
  },

  setAggFilters: async (partial: Partial<AggFilters>) => {
    const cat = get().selectedCategory;
    if (!cat.cmsType) return; // 非 CMS 分类不生效，不静默改豆瓣分类
    const merged: AggFilters = { ...(cat.filters || EMPTY_AGG_FILTERS), ...partial };
    if (JSON.stringify(merged) === JSON.stringify(cat.filters || EMPTY_AGG_FILTERS)) return;
    // CMS 与豆瓣 tag 互斥：选筛选即把 tag 置空，避免 tag + 筛选双重过滤。
    // 加载唯一入口就是这里的 fetchInitialData（index.tsx 对 CMS 模式不走 effect 重复加载）。
    // 2026-11-05：本函数是“立即应用”入口，只由“应用”、单组清除、
    // 全部清除调用；组内点选项只改 pending，不走这里，所以连选多组只发 1 次请求。
    const memory = { ...(get().cmsFilterMemory || {}) };
    memory[cat.cmsType] = {
      filters: { ...merged },
      filterOptions: cat.filterOptions,
      filtersVisible: get().filtersVisible,
    };
    set({
      selectedCategory: { ...cat, filters: merged, tag: undefined, cmsFallback: false },
      pendingFilters: { ...merged },
      cmsFilterMemory: memory,
      contentData: [],
      pageStart: 0,
      aggPage: 0,
      hasMore: true,
      error: null,
      loading: true,
      filterServiceUnavailable: false,
    });
    saveFilterMemory(memory);
    await get().fetchInitialData();
  },

  clearAggFilters: async () => {
    const cat = get().selectedCategory;
    if (!cat.cmsType) return;
    if (JSON.stringify(cat.filters || EMPTY_AGG_FILTERS) === JSON.stringify(EMPTY_AGG_FILTERS)) return;
    const memory = { ...(get().cmsFilterMemory || {}) };
    memory[cat.cmsType] = {
      filters: { ...EMPTY_AGG_FILTERS },
      filterOptions: cat.filterOptions,
      filtersVisible: get().filtersVisible,
    };
    set({
      selectedCategory: { ...cat, filters: { ...EMPTY_AGG_FILTERS }, tag: undefined, cmsFallback: false },
      pendingFilters: { ...EMPTY_AGG_FILTERS },
      cmsFilterMemory: memory,
      contentData: [],
      pageStart: 0,
      aggPage: 0,
      hasMore: true,
      error: null,
      loading: true,
      filterServiceUnavailable: false,
    });
    saveFilterMemory(memory);
    await get().fetchInitialData();
  },

  setPendingFilter: (key: keyof AggFilters, value: string) => {
    const cat = get().selectedCategory;
    if (!cat.cmsType) return;
    const base = get().pendingFilters || cat.filters || EMPTY_AGG_FILTERS;
    if (base[key] === value) return;
    set({ pendingFilters: { ...base, [key]: value } });
  },

  applyPendingFilters: async () => {
    const cat = get().selectedCategory;
    if (!cat.cmsType) return;
    const pending = get().pendingFilters;
    if (!pending) return;
    if (JSON.stringify(pending) === JSON.stringify(cat.filters || EMPTY_AGG_FILTERS)) return;
    await get().setAggFilters({ ...pending });
  },

  discardPendingFilters: () => {
    const cat = get().selectedCategory;
    if (!cat.cmsType) return;
    set({ pendingFilters: { ...(cat.filters || EMPTY_AGG_FILTERS) } });
  },

  clearAggFilterGroup: async (key: keyof AggFilters) => {
    // 单组清除是明确动作，立即生效并重查 1 次；与组内点选项（只改草稿）
    // 的语义分开，避免“点叉后还要再点应用”这种反直觉。
    await get().setAggFilters({ [key]: "" } as Partial<AggFilters>);
  },

  restoreFilterMemory: async () => {
    const memory = await loadFilterMemory();
    if (Object.keys(memory).length === 0) return;
    const cat = get().selectedCategory;
    const next: Record<string, unknown> = { cmsFilterMemory: memory };
    if (cat.cmsType && memory[cat.cmsType]) {
      const m = memory[cat.cmsType]!;
      next.selectedCategory = {
        ...cat,
        filters: { ...m.filters },
        filterOptions: m.filterOptions ?? cat.filterOptions,
        cmsFallback: false,
      };
      next.pendingFilters = { ...m.filters };
      if (typeof m.filtersVisible === "boolean") next.filtersVisible = m.filtersVisible;
    }
    set(next as never);
  },

  // 1.4.1 筛选栏开关：只改 filtersVisible，不触发任何加载、不改筛选值、
  // 不改缓存、不改分页。展开/收起后焦点不由 store 决定（见 index.tsx 注释）：
  // 开关本身始终挂载，是收起后的焦点落点；筛选值选择、重置均不调用本函数，
  // 故选完不自动收起。非 CMS 分类下调用亦无害（index.tsx 不渲染开关）。
  toggleFilters: () => {
    const next = !get().filtersVisible;
    const cat = get().selectedCategory;
    if (cat.cmsType) {
      const memory = { ...(get().cmsFilterMemory || {}) };
      memory[cat.cmsType] = {
        filters: { ...(cat.filters || EMPTY_AGG_FILTERS) },
        filterOptions: cat.filterOptions,
        filtersVisible: next,
      };
      set({ filtersVisible: next, cmsFilterMemory: memory });
      saveFilterMemory(memory);
    } else {
      set({ filtersVisible: next });
    }
  },

  setFiltersVisible: (visible: boolean) => {
    if (get().filtersVisible === visible) return;
    const cat = get().selectedCategory;
    if (cat.cmsType) {
      const memory = { ...(get().cmsFilterMemory || {}) };
      memory[cat.cmsType] = {
        filters: { ...(cat.filters || EMPTY_AGG_FILTERS) },
        filterOptions: cat.filterOptions,
        filtersVisible: visible,
      };
      set({ filtersVisible: visible, cmsFilterMemory: memory });
      saveFilterMemory(memory);
    } else {
      set({ filtersVisible: visible });
    }
  },

  refreshPlayRecords: async () => {
    const { apiBaseUrl } = useSettingsStore.getState();
    // 设置尚未加载完成（apiBaseUrl 为空）时无法判断登录态，直接跳过，
    // 避免冷启动首帧（子组件 focus 早于 loadSettings 完成）误删"最近播放"分类。
    if (!apiBaseUrl) return;
    await useAuthStore.getState().checkLoginStatus(apiBaseUrl);
    const { isLoggedIn } = useAuthStore.getState();
    if (!isLoggedIn) {
      set((state) => {
        const recordCategoryExists = state.categories.some((c) => c.type === "record");
        if (recordCategoryExists) {
          const newCategories = state.categories.filter((c) => c.type !== "record");
          if (state.selectedCategory.type === "record") {
            get().selectCategory(newCategories[0] || null);
          }
          return { categories: newCategories };
        }
        return {};
      });
      return;
    }
    const records = await PlayRecordManager.getAll();
    const hasRecords = Object.keys(records).length > 0;
    set((state) => {
      const recordCategoryExists = state.categories.some((c) => c.type === "record");
      if (hasRecords && !recordCategoryExists) {
        return { categories: [initialCategories[0], ...state.categories] };
      }
      if (!hasRecords && recordCategoryExists) {
        const newCategories = state.categories.filter((c) => c.type !== "record");
        if (state.selectedCategory.type === "record") {
          get().selectCategory(newCategories[0] || null);
        }
        return { categories: newCategories };
      }
      return {};
    });

    get().fetchInitialData();
  },

  clearError: () => {
    set({ error: null });
  },
}));

export default useHomeStore;
