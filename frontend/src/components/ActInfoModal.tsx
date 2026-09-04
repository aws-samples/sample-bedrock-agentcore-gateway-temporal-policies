// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { motion, AnimatePresence } from 'framer-motion';
import { ACT_INFO } from '../lib/actInfo';

export function ActInfoModal({ actId, onClose }: { actId: string | null; onClose: () => void }) {
  const info = actId ? ACT_INFO[actId] : null;
  return (
    <AnimatePresence>
      {info && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="modal modal-narrow"
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 30, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>{info.title}</h2>
              <button className="modal-close" onClick={onClose}>✕</button>
            </div>

            <div className="info-section">
              <h3>Scenario</h3>
              <p>{info.scenario}</p>
            </div>
            <div className="info-section info-risk">
              <h3>The risk</h3>
              <p>{info.risk}</p>
            </div>
            <div className="info-section info-before">
              <h3>Why this was not enforceable before</h3>
              <p>{info.before}</p>
            </div>
            <div className="info-section info-now">
              <h3>What Gateway + Dogwood changes</h3>
              <p>{info.now}</p>
            </div>
            <div className="info-reference">
              <code>{info.reference}</code>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
