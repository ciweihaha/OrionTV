import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator, Modal, useTVEventHandler, HWEvent, Text, TextInput, TouchableOpacity } from "react-native";
import LivePlayer from "@/components/LivePlayer";
import { getPlayableUrl, getCachedM3u, refreshM3u, Channel } from "@/services/m3u";
import { ThemedView } from "@/components/ThemedView";
import { StyledButton } from "@/components/StyledButton";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import { LiveChannelPrefsManager, LiveLastChannel } from "@/services/storage";
import Logger from "@/utils/Logger";

const logger = Logger.withTag('LiveScreen');

// 频道标题显示时长（毫秒）
const CHANNEL_TITLE_DISPLAY_MS = 3000;
// 数字换台：输入完成后提交的等待时间（毫秒）
const DIGIT_COMMIT_MS = 1500;
// 坏源自动跳台的连续失败上限（防死循环）
const MAX_AUTO_SKIP = 5;
// 收藏虚拟分组 key（不与真实分组名冲突）
const FAV_GROUP = "__fav__";

/**
 * Android TV 数字键 keyCode → 数字：KEYCODE_0..9 = 7..16，
 * RN useTVEventHandler 对未映射键上报 String(keyCode)；同时兼容直接上报 "0"-"9" 的设备。
 */
const DIGIT_KEY_MAP: Record<string, string> = {
  "7": "0", "8": "1", "9": "2", "10": "3", "11": "4",
  "12": "5", "13": "6", "14": "7", "15": "8", "16": "9",
};

export default function LiveScreen() {
  const { m3uUrl } = useSettingsStore();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  const [channels, setChannels] = useState<Channel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, Channel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [favChannels, setFavChannels] = useState<LiveLastChannel[]>([]);

  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isChannelListVisible, setIsChannelListVisible] = useState(false);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState(""); // 频道搜索过滤（V1.5）
  const titleTimer = useRef<NodeJS.Timeout | null>(null);
  const digitTimer = useRef<NodeJS.Timeout | null>(null);
  const digitBufRef = useRef("");                          // TV 事件闭包内读最新缓冲
  const failCountRef = useRef(0);                          // 连续失败计数（坏源跳台）
  const lastChannelRestoredRef = useRef(false);            // 上次频道只恢复一次
  const channelsRef = useRef<Channel[]>([]);               // 数字换台闭包内读最新列表

  useEffect(() => { channelsRef.current = channels; }, [channels]);

  // 组件卸载时清理标题/数字定时器，防止 setState 到已卸载组件
  useEffect(() => {
    return () => {
      if (titleTimer.current) {
        clearTimeout(titleTimer.current);
        titleTimer.current = null;
      }
      if (digitTimer.current) {
        clearTimeout(digitTimer.current);
        digitTimer.current = null;
      }
    };
  }, []);

  // 收藏频道加载（V1.5）
  useEffect(() => {
    LiveChannelPrefsManager.getFavChannels().then(setFavChannels);
  }, []);

  const showChannelTitle = (title: string) => {
    setChannelTitle(title);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => setChannelTitle(null), CHANNEL_TITLE_DISPLAY_MS);
  };

  // 分组构建（V1.5：有收藏时在最前插入收藏虚拟分组）
  const buildGroups = useCallback((list: Channel[], favs: LiveLastChannel[]) => {
    const groups: Record<string, Channel[]> = {};
    if (favs.length > 0) {
      groups[FAV_GROUP] = list.filter((c) => favs.some((f) => f.url === c.url));
    }
    for (const channel of list) {
      const groupName = channel.group || "Other";
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(channel);
    }
    return groups;
  }, []);

  // 记住上次频道（V1.5）：换台/选台时保存
  const saveLastChannel = useCallback((channel: Channel) => {
    LiveChannelPrefsManager.saveLastChannel({ url: channel.url, name: channel.name }).catch(() => {});
  }, []);

  const selectChannelByIndex = useCallback((index: number, list: Channel[]) => {
    if (index < 0 || index >= list.length) return;
    setCurrentChannelIndex(index);
    failCountRef.current = 0; // 手动换台清零自动跳台计数
    showChannelTitle(list[index].name);
    saveLastChannel(list[index]);
  }, [saveLastChannel]);

  const handleSelectChannel = (channel: Channel) => {
    const globalIndex = channels.findIndex((c) => c.id === channel.id);
    if (globalIndex !== -1) {
      selectChannelByIndex(globalIndex, channels);
      setIsChannelListVisible(false);
      setChannelFilter(""); // 关闭列表后清空过滤，下次打开为完整列表
    }
  };

  const changeChannel = useCallback(
    (direction: "next" | "prev") => {
      const list = channelsRef.current;
      if (list.length === 0) return;
      let newIndex =
        direction === "next"
          ? (currentChannelIndex + 1) % list.length
          : (currentChannelIndex - 1 + list.length) % list.length;
      selectChannelByIndex(newIndex, list);
    },
    [currentChannelIndex, selectChannelByIndex]
  );

  // ---------- V1.5：数字键换台 ----------
  const commitDigits = useCallback(() => {
    const n = parseInt(digitBufRef.current, 10);
    digitBufRef.current = "";
    if (digitTimer.current) {
      clearTimeout(digitTimer.current);
      digitTimer.current = null;
    }
    const list = channelsRef.current;
    if (!isNaN(n) && n >= 1 && n <= list.length) {
      selectChannelByIndex(n - 1, list);
    } else if (!isNaN(n)) {
      showChannelTitle(`无 ${n} 号频道`);
    }
  }, [selectChannelByIndex]);

  const handleDigit = useCallback((digit: string) => {
    const next = (digitBufRef.current + digit).slice(-4); // 最多 4 位，超出丢最早
    digitBufRef.current = next;
    showChannelTitle(`输入频道号：${next}`);
    // 唯一匹配立即切换：存在该号且不存在以它为前缀的更大号（如输入 5 但列表有 50+）
    const n = parseInt(next, 10);
    const list = channelsRef.current;
    const hasLonger = !isNaN(n) && list.length >= (n + 1) * 10;
    if (!isNaN(n) && n >= 1 && n <= list.length && !hasLonger) {
      commitDigits();
      return;
    }
    if (digitTimer.current) clearTimeout(digitTimer.current);
    digitTimer.current = setTimeout(commitDigits, DIGIT_COMMIT_MS);
  }, [commitDigits]);

  // ---------- V1.5：收藏当前频道 ----------
  const toggleFavCurrent = useCallback(async () => {
    const ch = channelsRef.current[currentChannelIndex];
    if (!ch) return;
    const added = await LiveChannelPrefsManager.toggleFavChannel({ url: ch.url, name: ch.name });
    setFavChannels(await LiveChannelPrefsManager.getFavChannels());
    showChannelTitle(`${ch.name}  ${added ? "★ 已收藏" : "已取消收藏"}`);
  }, [currentChannelIndex]);

  const toggleFavChannelItem = useCallback(async (channel: Channel) => {
    const added = await LiveChannelPrefsManager.toggleFavChannel({ url: channel.url, name: channel.name });
    const favs = await LiveChannelPrefsManager.getFavChannels();
    setFavChannels(favs);
    showChannelTitle(`${channel.name}  ${added ? "★ 已收藏" : "已取消收藏"}`);
  }, []);

  // 收藏变化 → 重建分组（收藏虚拟组置顶）
  useEffect(() => {
    setGroupedChannels(buildGroups(channels, favChannels));
    setChannelGroups(Object.keys(buildGroups(channels, favChannels)));
  }, [channels, favChannels, buildGroups]);

  // m3u 加载（V1.5：缓存秒进 + 后台刷新 + 恢复上次频道）
  useEffect(() => {
    let cancelled = false;
    const loadChannels = async () => {
      if (!m3uUrl) return;
      setIsLoading(true);
      lastChannelRestoredRef.current = false;

      // 1) 缓存优先（内存 → 磁盘）：有缓存先渲染，直播页秒开
      const cached = await getCachedM3u(m3uUrl);
      if (cancelled) return;
      if (cached.length > 0) {
        setChannels(cached);
        setIsLoading(false);
        if (!lastChannelRestoredRef.current) {
          lastChannelRestoredRef.current = true;
          const last = await LiveChannelPrefsManager.getLastChannel();
          const idx = last ? cached.findIndex((c) => c.url === last.url) : -1;
          if (idx >= 0) {
            setCurrentChannelIndex(idx);
            showChannelTitle(cached[idx].name);
          } else if (cached.length > 0) {
            showChannelTitle(cached[0].name);
          }
        }
      }

      // 2) 网络刷新（无缓存时这就是首次加载；有缓存时为后台更新）
      const fresh = await refreshM3u(m3uUrl);
      if (cancelled) return;
      if (fresh.length > 0) {
        setChannels(fresh);
        if (!lastChannelRestoredRef.current) {
          lastChannelRestoredRef.current = true;
          const last = await LiveChannelPrefsManager.getLastChannel();
          const idx = last ? fresh.findIndex((c) => c.url === last.url) : -1;
          if (idx >= 0) {
            setCurrentChannelIndex(idx);
            showChannelTitle(fresh[idx].name);
          } else if (fresh.length > 0) {
            showChannelTitle(fresh[0].name);
          }
        }
      } else if (cached.length === 0) {
        logger.info("m3u load failed and no cache available");
      }
      setIsLoading(false);
    };
    loadChannels();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m3uUrl]);

  // ---------- V1.5：坏源自动跳台 ----------
  const handlePlaybackError = useCallback(() => {
    const list = channelsRef.current;
    if (list.length === 0) return;
    failCountRef.current += 1;
    if (failCountRef.current > MAX_AUTO_SKIP) {
      showChannelTitle("连续切换失败，请按左右键手动换台");
      return;
    }
    showChannelTitle("信号异常，自动切换下一频道…");
    changeChannel("next");
  }, [changeChannel]);

  const handlePlaybackStatus = useCallback((status: { isLoaded?: boolean; isPlaying?: boolean }) => {
    if (status.isLoaded && status.isPlaying) {
      failCountRef.current = 0; // 播放成功清零
    }
  }, []);

  const handleTVEvent = useCallback(
    (event: HWEvent) => {
      if (deviceType !== 'tv') return;
      if (isChannelListVisible) return;
      const t = event.eventType ?? "";
      // 数字键换台（V1.5）：先于方向键处理
      const digit = /^[0-9]$/.test(t) ? t : DIGIT_KEY_MAP[t];
      if (digit) {
        handleDigit(digit);
        return;
      }
      if (t === "menu") {
        toggleFavCurrent();
        return;
      }
      if (t === "down") setIsChannelListVisible(true);
      else if (t === "left") changeChannel("prev");
      else if (t === "right") changeChannel("next");
    },
    [changeChannel, isChannelListVisible, deviceType, handleDigit, toggleFavCurrent]
  );

  useTVEventHandler(deviceType === 'tv' ? handleTVEvent : () => {});

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  // 频道列表数据（V1.5：搜索过滤时跨全部频道，否则按当前分组）
  const visibleChannels = useMemo(() => {
    const keyword = channelFilter.trim().toLowerCase();
    if (keyword) {
      return channels.filter((c) => c.name.toLowerCase().includes(keyword));
    }
    return groupedChannels[selectedGroup] || [];
  }, [channelFilter, channels, groupedChannels, selectedGroup]);

  const renderLiveContent = () => (
    <>
      <LivePlayer
        streamUrl={selectedChannelUrl}
        channelTitle={channelTitle}
        onPlaybackStatusUpdate={handlePlaybackStatus}
        onPlaybackError={handlePlaybackError}
      />
      <Modal
        animationType="slide"
        transparent={true}
        visible={isChannelListVisible}
        onRequestClose={() => setIsChannelListVisible(false)}
      >
        <View style={dynamicStyles.modalContainer}>
          <View style={dynamicStyles.modalContent}>
            <Text style={dynamicStyles.modalTitle}>选择频道</Text>
            <View style={dynamicStyles.searchBox}>
              <TextInput
                style={dynamicStyles.searchInput}
                placeholder="搜索频道…（过滤时搜全部频道）"
                placeholderTextColor="#888"
                value={channelFilter}
                onChangeText={setChannelFilter}
                returnKeyType="done"
              />
            </View>
            <View style={dynamicStyles.listContainer}>
              <View style={dynamicStyles.groupColumn}>
                <FlatList
                  data={channelGroups}
                  keyExtractor={(item, index) => `group-${item}-${index}`}
                  renderItem={({ item }) => (
                    <StyledButton
                      text={item === FAV_GROUP ? "★ 收藏" : item}
                      onPress={() => { setSelectedGroup(item); setChannelFilter(""); }}
                      isSelected={selectedGroup === item && !channelFilter}
                      style={dynamicStyles.groupButton}
                      textStyle={dynamicStyles.groupButtonText}
                    />
                  )}
                />
              </View>
              <View style={dynamicStyles.channelColumn}>
                {isLoading ? (
                  <ActivityIndicator size="large" />
                ) : (
                  <FlatList
                    data={visibleChannels}
                    keyExtractor={(item, index) => `${item.id}-${item.group}-${index}`}
                    renderItem={({ item }) => {
                      const isCurrent = channels[currentChannelIndex]?.id === item.id;
                      const isFav = favChannels.some((f) => f.url === item.url);
                      return (
                        <TouchableOpacity
                          onPress={() => handleSelectChannel(item)}
                          onLongPress={() => toggleFavChannelItem(item)}
                          style={[
                            dynamicStyles.channelItem,
                            isCurrent && dynamicStyles.channelItemActive,
                          ]}
                        >
                          <Text
                            numberOfLines={1}
                            style={[dynamicStyles.channelItemText, isCurrent && dynamicStyles.channelItemTextActive]}
                          >
                            {item.name || "Unknown Channel"}
                          </Text>
                          <Text style={dynamicStyles.favMark}>{isFav ? "★" : ""}</Text>
                        </TouchableOpacity>
                      );
                    }}
                  />
                )}
              </View>
            </View>
            <Text style={dynamicStyles.hintText}>长按频道项收藏；TV 遥控器菜单键收藏当前频道、数字键直接换台</Text>
          </View>
        </View>
      </Modal>
    </>
  );

  const selectedChannelUrl = channels.length > 0 ? getPlayableUrl(channels[currentChannelIndex]?.url ?? null) : null;

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderLiveContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="直播" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    modalContainer: {
      flex: 1,
      flexDirection: "row",
      justifyContent: isMobile ? "center" : "flex-end",
      backgroundColor: "transparent",
    },
    modalContent: {
      width: isMobile ? '90%' : isTablet(deviceType) ? 400 : 450,
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
      padding: spacing,
    },
    modalTitle: {
      color: "white",
      marginBottom: spacing / 2,
      textAlign: "center",
      fontSize: isMobile ? 18 : 16,
      fontWeight: "bold",
    },
    searchBox: {
      marginBottom: spacing / 2,
      backgroundColor: "rgba(255, 255, 255, 0.08)",
      borderRadius: 8,
      paddingHorizontal: spacing / 2,
    },
    searchInput: {
      color: "white",
      fontSize: isMobile ? 15 : 14,
      height: isMobile ? minTouchTarget * 0.8 : 40,
    },
    listContainer: {
      flex: 1,
      flexDirection: isMobile ? "column" : "row",
    },
    groupColumn: {
      flex: isMobile ? 0 : 1,
      marginRight: isMobile ? 0 : spacing / 2,
      marginBottom: isMobile ? spacing : 0,
      maxHeight: isMobile ? 120 : undefined,
    },
    channelColumn: {
      flex: isMobile ? 1 : 2,
    },
    groupButton: {
      paddingVertical: isMobile ? minTouchTarget / 4 : 8,
      paddingHorizontal: spacing / 2,
      marginVertical: isMobile ? 2 : 4,
      minHeight: isMobile ? minTouchTarget * 0.7 : undefined,
    },
    groupButtonText: {
      fontSize: isMobile ? 14 : 13,
    },
    channelItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: isMobile ? minTouchTarget / 5 : 8,
      paddingHorizontal: spacing,
      marginVertical: isMobile ? 2 : 2,
      minHeight: isMobile ? minTouchTarget * 0.8 : undefined,
      borderRadius: 6,
    },
    channelItemActive: {
      backgroundColor: "rgba(79, 163, 227, 0.25)",
    },
    channelItemText: {
      color: "white",
      fontSize: isMobile ? 14 : 12,
      flex: 1,
    },
    channelItemTextActive: {
      color: "#4FA3E3",
      fontWeight: "bold",
    },
    favMark: {
      color: "#D9A521",
      fontSize: isMobile ? 14 : 12,
      marginLeft: 6,
    },
    hintText: {
      color: "#8A97A5",
      fontSize: 11,
      textAlign: "center",
      marginTop: spacing / 2,
    },
  });
};

// 辅助：modalContent 宽度判断（避免三元嵌套可读性差）
function isTablet(deviceType: string) {
  return deviceType === "tablet";
}
