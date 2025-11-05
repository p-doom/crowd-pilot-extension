#!/usr/bin/env python3
"""
CSV sessions -> ArrayRecord shards for MaxText Grain pretraining.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import List, Tuple, cast
import random

import pandas as pd

from array_record.python import array_record_module as arm # type: ignore

import tensorflow as tf 
from serialization_utils import (
    SerializeConfig,
    _session_to_transcript,
    _discover_local_sessions,
    _chunk_text,
)


def to_array_record(
    cfg: SerializeConfig,
) -> None:
    os.makedirs(cfg.output_dir, exist_ok=True)

    required_cols = ["Sequence", "Time", "File", "RangeOffset", "RangeLength", "Text", "Language", "Type"]

    session_dataframes: List[Tuple[pd.DataFrame, str]] = []
    root = Path(cast(str, cfg.csv_root)).expanduser().resolve()
    csv_files = _discover_local_sessions(root)
    assert csv_files, f"No CSV files found under {root}"
    for csv_file in csv_files:
        df = pd.read_csv(csv_file)
        missing_local = [c for c in required_cols if c not in df.columns]
        assert not missing_local, f"Missing required CSV columns in {csv_file}: {missing_local}"
        session_dataframes.append((df, str(csv_file)))

    random.seed(42)
    session_dataframes = [(df, path) for df, path in session_dataframes]
    random.shuffle(session_dataframes)
    
    total_sessions = len(session_dataframes)
    val_count = int(total_sessions * cfg.val_ratio)
    train_count = total_sessions - val_count

    train_rows = 0
    val_rows = 0
    train_shard_idx = 0
    val_shard_idx = 0
    docs_written = 0

    def write_shard(chunks: List[str], split: str, shard_idx: int) -> int:
        if not chunks:
            return 0
        out_path = Path(cfg.output_dir) / f"{split}_{shard_idx:05d}.array_record"
        group_size = cfg.arrayrecord_group_size
        options = f"group_size:{group_size}"
        writer = arm.ArrayRecordWriter(str(out_path), options)
        try:
            for chunk in chunks:
                example = tf.train.Example(
                    features=tf.train.Features(
                        feature={
                            "text": tf.train.Feature(
                                bytes_list=tf.train.BytesList(value=[chunk.encode("utf-8")])
                            )
                        }
                    )
                )
                writer.write(example.SerializeToString())
        finally:
            writer.close()
        return len(chunks)

    for i, (session_df, session_path) in enumerate(session_dataframes):
        session_df = pd.DataFrame(session_df.copy())
        transcript = _session_to_transcript(
            session_df,
            long_pause_threshold_ms=cfg.long_pause_threshold_ms,
        )
        if len(transcript.strip()) < cfg.min_session_chars:
            print(f"Skipping session {session_path} because it's too short ({len(transcript.strip())} chars)")
            continue
        chunks = _chunk_text(transcript, cfg.target_chars, cfg.overlap_chars)
        if not chunks:
            continue
        docs_written += len(chunks)
        
        if i < train_count:
            rows_written = write_shard(chunks, "train", train_shard_idx)
            train_rows += rows_written
            train_shard_idx += 1
        else:
            rows_written = write_shard(chunks, "val", val_shard_idx)
            val_rows += rows_written
            val_shard_idx += 1
            
        if cfg.max_docs and docs_written >= cfg.max_docs:
            break

    print(f"Wrote {train_rows} train and {val_rows} val documents to {cfg.output_dir}")


def parse_args() -> SerializeConfig:
    p = argparse.ArgumentParser(description="Serialize HF CSV sessions to ArrayRecord for MaxText Grain")
    p.add_argument("--csv_root", type=str, required=True, help="Root directory containing per-session CSV files")
    p.add_argument("--output_dir", type=str, required=True, help="Output directory for ArrayRecord shards")
    p.add_argument("--shard_size", type=int, default=20000, help="Rows per shard (currently one session per shard)")
    # FIXME(f.srambical): It is awkward that the target number is in character-space instead of in token-space.
    p.add_argument("--target_chars", type=int, default=8192, help="Target characters per document chunk. This should be ~3-4x the max token length of the model you are using.")
    p.add_argument("--overlap_chars", type=int, default=128, help="Character overlap between chunks")
    p.add_argument("--min_session_chars", type=int, default=1024, help="Minimum characters to keep a session")
    p.add_argument("--max_docs", type=int, default=None, help="Stop after writing this many unique docs")
    p.add_argument("--long_pause_threshold_ms", type=int, default=120000, help="Threshold (ms) to annotate long pauses and emit a keyframe")
    p.add_argument("--val_ratio", type=float, default=0.10, help="Fraction of sessions to route to validation [0,1)")
    p.add_argument("--arrayrecord_group_size", type=int, default=1, help="ArrayRecord group_size option controlling index granularity and compression grouping")
    args = p.parse_args()
    return SerializeConfig(
        output_dir=args.output_dir,
        shard_size=args.shard_size,
        target_chars=args.target_chars,
        overlap_chars=args.overlap_chars,
        min_session_chars=args.min_session_chars,
        max_docs=args.max_docs,
        long_pause_threshold_ms=args.long_pause_threshold_ms,
        csv_root=(args.csv_root if args.csv_root else None),
        val_ratio=args.val_ratio,
        arrayrecord_group_size=args.arrayrecord_group_size,
    )


def main() -> None:
    cfg = parse_args()
    to_array_record(cfg)


if __name__ == "__main__":
    main()