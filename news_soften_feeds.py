#!/usr/bin/env python3
# Rebalance the /news feed list toward softer teaching/encouragement sources.
# Drops the hard-news Christian Post categories. Dead feeds are skipped at runtime.
# RUN FROM THE BACKEND FOLDER: ~/Desktop/biblestudygenius-api
import sys, os

P = "src/news.js"
if not os.path.exists(P):
    print("ABORT - run from ~/Desktop/biblestudygenius-api (src/news.js not found)")
    sys.exit(1)

s = open(P, encoding="utf-8").read()

OLD = '''const FEEDS = [
  { source: "The Christian Post", url: "https://www.christianpost.com/category/featured-news/rss" },
  { source: "The Christian Post", url: "https://www.christianpost.com/category/us/rss" },
  { source: "The Christian Post", url: "https://www.christianpost.com/category/world/rss" },
  { source: "The Christian Post", url: "https://www.christianpost.com/category/church-ministries/rss" },
  { source: "The Gospel Coalition", url: "https://www.thegospelcoalition.org/feed/" },
  { source: "Relevant", url: "https://relevantmagazine.com/feed/" },
  { source: "Baptist Press", url: "https://www.baptistpress.com/feed/" },
];'''

NEW = '''const FEEDS = [
  { source: "The Gospel Coalition", url: "https://www.thegospelcoalition.org/feed/" },
  { source: "Relevant", url: "https://relevantmagazine.com/feed/" },
  { source: "Desiring God", url: "https://www.desiringgod.org/blog.rss" },
  { source: "(in)courage", url: "https://www.incourage.me/feed/" },
  { source: "Crosswalk", url: "https://www.crosswalk.com/devotionals/your-daily-bible-verse/rss/" },
];'''

if "The Christian Post" not in s and "The Gospel Coalition" in s:
    print("looks already rebalanced (no Christian Post entries) — leaving as-is")
    sys.exit(0)

if OLD not in s:
    print("ABORT - FEEDS block doesn't match what was expected (was it hand-edited?).")
    print("Open src/news.js and replace the FEEDS array manually, or tell me the current contents.")
    sys.exit(1)

s = s.replace(OLD, NEW, 1)
open(P, "w", encoding="utf-8").write(s)
print("feeds rebalanced to softer sources OK")
