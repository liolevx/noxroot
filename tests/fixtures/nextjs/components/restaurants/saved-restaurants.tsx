import { listSavedRestaurants } from "../../lib/restaurant-store";

export function SavedRestaurants() {
  const restaurants = listSavedRestaurants();
  return (
    <ul>
      {restaurants.map((restaurant) => (
        <li key={restaurant}>{restaurant}</li>
      ))}
    </ul>
  );
}
