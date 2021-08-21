import React, { useState } from "react";
// import dateFormat from "dateformat";
import ButtonCollapse from "../common/ButtonExpand";
import EventRenderReason from "./EventRenderReasonDetails";
import ElementId from "../common/ElementId";
import { TreeElement, Event } from "../../types";

interface EventListItemProps {
  component: TreeElement;
  event: Event;
}

function getReasons(event: Event) {
  const reasons: string[] = [];

  if (event.op === "rerender") {
    const { context, hooks, props, state, parentUpdate } = event.changes || {};

    if (context) {
      reasons.push("Context changed");
    }

    if (hooks) {
      reasons.push("Hooks changed");
    }

    if (props) {
      reasons.push("Props changed");
    }

    if (state) {
      reasons.push("State changed");
    }

    if (parentUpdate) {
      reasons.push("Parent render");
    }
  }

  return reasons;
}

function formatDuration(duration: number) {
  let unit = "ms";

  if (duration >= 100) {
    duration /= 100;
    unit = "s";
  }

  if (duration >= 100) {
    duration /= 100;
    unit = "m";
  }

  return duration.toFixed(1) + unit;
}

const EventListItem = ({ component, event }: EventListItemProps) => {
  const [expanded, setIsCollapsed] = useState(false);
  const reasons = getReasons(event);
  const hasDetails =
    event.op === "rerender" &&
    (event.changes?.props || event.changes?.state || event.changes?.hooks);

  return (
    <>
      <tr className="event-list-item">
        <td className="event-list-item__event-type">
          <span
            className="event-list-item__event-type-label"
            data-type={event.op}
          >
            {event.op}
          </span>
        </td>

        <td className="event-list-item__time">
          {(event.op === "mount" || event.op === "rerender") &&
            formatDuration(event.selfDuration)}
        </td>
        <td className="event-list-item__time">
          {(event.op === "mount" || event.op === "rerender") &&
            formatDuration(event.actualDuration)}
        </td>
        {/* <td className="event-list-item__timestamp">
          <span className="event-list-item__timestamp-label">
            {dateFormat(Number(event.timestamp), "HH:MM:ss.l")}
          </span>
        </td> */}
        <td className="event-list-item__details">
          <span className="event-list-item__name">
            {component.displayName || "Unknown"}
          </span>
          <ElementId id={component.id} />{" "}
          {reasons.length > 0 && (
            <span className="event-list-item__reasons">
              {hasDetails && (
                <ButtonCollapse
                  expanded={expanded}
                  setExpanded={setIsCollapsed}
                />
              )}
              {reasons.join(", ")}
            </span>
          )}
        </td>
      </tr>
      {event.op === "rerender" && expanded && (
        <EventRenderReason changes={event.changes} />
      )}
    </>
  );
};

export default EventListItem;